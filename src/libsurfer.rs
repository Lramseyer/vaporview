use wellen::{FileFormat, Hierarchy, TimescaleUnit, CompressedTimeTable};
use bincode::Options;

use crate::{BINCODE_OPTIONS, _hierarchy, _file_format, _time_table, _hierarchy_chunks, _hierarchy_total_chunks, _timetable_chunks, _timetable_total_chunks, _signals_chunks, _signals_total_chunks, get_scope_data, get_var_data, outputlog, setmetadata, setscopetop, setvartop, setchunksize, sendtransitiondatachunk, SurferStatus};

pub enum ChunkType {
  Hierarchy,
  TimeTable,
  Signals,
}

pub struct SurferRemote;

/*
  These are the four routes that the surfer server uses (get_status, get_hierarchy, get_timetable, get_signals).
  I couldn't get async functions to work in Rust, so the HTTP call is done in Typescript and the response bytes 
  are passed to these functions. I also noticed that wasm crashed when the byte vector was too large, so I split 
  the data into chunks. It is more complicated than I would like, but it works.
 */

impl SurferRemote {
  fn handle_chunk(chunk_type: ChunkType, chunk_data: Vec<u8>, chunk_index: u32, total_chunks: u32) {
    match chunk_type {
      ChunkType::Hierarchy => {
        Self::handle_chunk_impl(&_hierarchy_chunks, &_hierarchy_total_chunks, Self::loadremotehierarchy, chunk_data, chunk_index, total_chunks);
      },
      ChunkType::TimeTable => {
        Self::handle_chunk_impl(&_timetable_chunks, &_timetable_total_chunks, Self::loadremotetimetable, chunk_data, chunk_index, total_chunks);
      },
      ChunkType::Signals => {
        Self::handle_chunk_impl(&_signals_chunks, &_signals_total_chunks, Self::loadremotesignals, chunk_data, chunk_index, total_chunks);
      },
    }
  }

  fn handle_chunk_impl(
    chunks_mutex: &std::sync::Mutex<Vec<Vec<u8>>>,
    total_chunks_mutex: &std::sync::Mutex<u32>,
    process_fn: fn(Vec<u8>),
    chunk_data: Vec<u8>,
    chunk_index: u32,
    total_chunks: u32,
  ) {
    let mut chunks = chunks_mutex.lock().unwrap();
    let mut total_chunks_ref = total_chunks_mutex.lock().unwrap();
    
    // Initialize chunks vector if this is the first chunk
    if chunk_index == 0 {
      *total_chunks_ref = total_chunks;
      chunks.clear();
      chunks.resize(total_chunks as usize, Vec::new());
    }
    
    // Store the chunk
    chunks[chunk_index as usize] = chunk_data;
    
    // Check if all chunks are received
    let all_received = chunks.iter().all(|chunk| !chunk.is_empty());
    if all_received {
      let mut reassembled_data = Vec::new();
      for chunk in chunks.iter() {
        reassembled_data.extend_from_slice(&chunk);
      }
      process_fn(reassembled_data);
      chunks.clear();
      *total_chunks_ref = 0;
    }
  }
  pub fn loadremotestatus(status_data: Vec<u8>) -> String {
    let status_text = String::from_utf8(status_data).unwrap_or_else(|_| {
      outputlog("Failed to decode status data as UTF-8");
      return String::from("{}");
    });
    let status: SurferStatus = serde_json::from_str(&status_text).unwrap();
    outputlog(&format!("Connected to Surfer server: {}", status.filename));
    outputlog(&format!("File format: {}, Wellen version: {}, Surfer version: {}", 
        status.file_format, status.wellen_version, status.surfer_version));
    outputlog(&format!("Bytes loaded: {}/{}", status.bytes_loaded, status.bytes));
    return status.filename;
  }

  pub fn loadremotehierarchy(hierarchy_data: Vec<u8>) {
    outputlog(&format!("Loading remote hierarchy, binary data size: {}", hierarchy_data.len()));
    
    // Data is already binary, no need to decode from base64
    match lz4_flex::decompress_size_prepended(&hierarchy_data) {
      Ok(raw) => {
        let mut reader = std::io::Cursor::new(raw);
        
        let opts = BINCODE_OPTIONS.allow_trailing_bytes();
        
        // Deserialize file format first
        let file_format_result: Result<FileFormat, _> = opts.deserialize_from(&mut reader);
        match file_format_result {
          Ok(file_format) => {
            // Deserialize hierarchy
            let hierarchy_result: Result<Hierarchy, _> = BINCODE_OPTIONS.deserialize_from(&mut reader);
            match hierarchy_result {
              Ok(hierarchy) => {
                let mut global_hierarchy = _hierarchy.lock().unwrap();
                let mut global_file_format = _file_format.lock().unwrap();
                *global_hierarchy = Some(hierarchy);
                *global_file_format = file_format;
                outputlog(&format!("Successfully loaded remote hierarchy ({} bytes binary)", hierarchy_data.len()));
                
                // Set metadata like in loadfile
                let hier = global_hierarchy.as_ref().unwrap();
                let scope_count = hier.iter_scopes().count() as u32;
                let var_count = hier.iter_vars().count() as u32;
                let time_scale_data = hier.timescale();
                let time_unit = match time_scale_data {
                  Some(scale) => {
                    match scale.unit {
                      TimescaleUnit::ZeptoSeconds => "zs".to_string(),
                      TimescaleUnit::AttoSeconds => "as".to_string(),
                      TimescaleUnit::FemtoSeconds => "fs".to_string(),
                      TimescaleUnit::PicoSeconds => "ps".to_string(),
                      TimescaleUnit::NanoSeconds => "ns".to_string(),
                      TimescaleUnit::MicroSeconds => "us".to_string(),
                      TimescaleUnit::MilliSeconds => "ms".to_string(),
                      TimescaleUnit::Seconds => "s".to_string(),
                      TimescaleUnit::Unknown => "s".to_string()
                    }
                  },
                  None => "s".to_string(),
                };
                let time_scale = match time_scale_data {
                  Some(scale) => scale.factor,
                  None => 1,
                } as u32;
                setmetadata(scope_count, var_count, time_scale, time_unit.as_str());
                
                // Set scope and var data
                for s in hier.scopes() {
                  let scope_data = get_scope_data(&hier, s);
                  setscopetop(&scope_data.name, scope_data.id, &scope_data.tpe);
                }
                
                for v in hier.vars() {
                  let var_data = get_var_data(&hier, v);
                  setvartop(&var_data.name, var_data.id, var_data.signal_id, &var_data.tpe, &var_data.encoding, var_data.width, var_data.msb, var_data.lsb);
                }
                
              },
              Err(e) => outputlog(&format!("Failed to deserialize hierarchy: {:?}", e))
            }
          },
          Err(e) => outputlog(&format!("Failed to deserialize file format: {:?}", e))
        }
      },
      Err(e) => outputlog(&format!("Failed to decompress hierarchy data: {:?}", e))
    }
  }

  pub fn loadremotetimetable(timetable_data: Vec<u8>) {
    outputlog(&format!("Loading remote time table, binary data size: {}", timetable_data.len()));
    
    // Data is already binary, no need to decode from base64
    let compressed_result: Result<CompressedTimeTable, _> = BINCODE_OPTIONS.deserialize(&timetable_data);
    match compressed_result {
      Ok(compressed) => {
        let time_table = compressed.uncompress();
        let mut global_time_table = _time_table.lock().unwrap();
        *global_time_table = Some(time_table);
        
        let tt = global_time_table.as_ref().unwrap();
        let mut min_timestamp = 9999999;
        let event_count = tt.len();
        let time_table_length = tt.len();
        let time_end = tt[time_table_length - 1];
        let time_end_extend = time_end + (time_end as f32 / time_table_length as f32).ceil() as u64;
        
        if event_count <= 128 {
          min_timestamp = tt[event_count - 1];
        } else {
          for i in 128..event_count {
            let rolling_time_step = tt[i] - tt[i - 128];
            min_timestamp = std::cmp::min(rolling_time_step, min_timestamp);
          }
        }
        
        setchunksize(min_timestamp, time_end_extend, time_table_length as u64);
        outputlog(&format!("Successfully loaded remote time table ({} events)", event_count));
      },
      Err(e) => outputlog(&format!("Failed to deserialize time table: {:?}", e))
    }
  }

  pub fn loadremotesignals(signals_data: Vec<u8>) {
    outputlog(&format!("Loading remote signals, binary data size: {}", signals_data.len()));
    
    // Check if data size is reasonable (limit to ~50MB binary data)
    if signals_data.len() > 50 * 1024 * 1024 {
      outputlog(&format!("Remote signals data too large: {} bytes", signals_data.len()));
      return;
    }
    
    // Data is already binary, no need to decode from base64  
    let mut reader = std::io::Cursor::new(signals_data);
    
    // Read number of signals using LEB128
    let num_ids_result: Result<u64, _> = leb128::read::unsigned(&mut reader);
    match num_ids_result {
      Ok(num_ids) => {
        if num_ids == 0 {
          outputlog("No signals in remote response");
          return;
        }
        
        let opts = BINCODE_OPTIONS.allow_trailing_bytes();
        let mut signals = Vec::new();
        
        // Deserialize all but the last signal with trailing bytes allowed
        for i in 0..(num_ids - 1) {
          let compressed_result: Result<wellen::CompressedSignal, _> = opts.deserialize_from(&mut reader);
          match compressed_result {
            Ok(compressed) => {
              match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                compressed.uncompress()
              })) {
                Ok(signal) => {
                  outputlog(&format!("Successfully uncompressed signal {}", i));
                  signals.push((signal.signal_ref(), signal));
                },
                Err(_) => {
                  outputlog(&format!("Failed to uncompress signal {} (panic caught)", i));
                  return;
                }
              }
            },
            Err(e) => {
              outputlog(&format!("Failed to deserialize signal {}: {:?}", i, e));
              return;
            }
          }
        }
        
        // Deserialize the final signal (should consume all remaining bytes)
        let final_compressed_result: Result<wellen::CompressedSignal, _> = BINCODE_OPTIONS.deserialize_from(&mut reader);
        match final_compressed_result {
          Ok(compressed) => {
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
              compressed.uncompress()
            })) {
              Ok(signal) => {
                outputlog("Successfully uncompressed final signal");
                signals.push((signal.signal_ref(), signal));
              },
              Err(_) => {
                outputlog("Failed to uncompress final signal (panic caught)");
                return;
              }
            }
            
            // Process the signals and send transition data chunks
            let global_time_table = _time_table.lock().unwrap();
            match global_time_table.as_ref() {
              Some(time_table) => {
                outputlog(&format!("Processing {} remote signals", signals.len()));
                
                // Process each signal similar to getsignaldata
                signals.iter().for_each(|(signal_ref, signal)| {
                  let signalid = signal_ref.index() as u32;
                  let transitions = signal.iter_changes();
                  let time_index = signal.time_indices();
                  
                  // Check if signal has too many transitions (limit to ~1M transitions)
                  if time_index.len() > 1_000_000 {
                    outputlog(&format!("Signal {} has too many transitions: {}, skipping", signalid, time_index.len()));
                    sendtransitiondatachunk(signalid, 1, 0, 0.0, 1.0, "[]");
                    return;
                  }
                  
                  let mut result = String::new();
                  result.push_str("[");

                  let mut i: usize = 0;
                  let mut min: f64 = 0.0;
                  let mut max: f64 = 0.0;
                  for (_, value) in transitions {
                    let v = value.to_string();
                    let time = time_table[time_index[i] as usize];
                    match value {
                      wellen::SignalValue::Real(v) => {
                        min = f64::min(min, v);
                        max = f64::max(max, v);
                      },
                      _ => {}
                    }
                    result.push_str(&format!("[{:?},{:?}],", time, v));
                    i += 1;
                    
                    // Prevent result string from getting too large
                    if result.len() > 10_000_000 {
                      outputlog(&format!("Signal {} result string getting too large, truncating", signalid));
                      break;
                    }
                  }

                  // Close the array
                  if result.len() > 1 {result.pop();}
                  result.push_str("]");

                  // Send the data in chunks
                  let max_return_length = 65000;
                  let result_length = result.len();
                  let chunk_count = (result_length as f32 / max_return_length as f32).ceil() as u32;
                  for i in 0..chunk_count {
                    let start = i * max_return_length;
                    let end = std::cmp::min((i + 1) * max_return_length, result_length as u32);
                    let chunk = &result[start as usize..end as usize];
                    sendtransitiondatachunk(signalid, chunk_count, i as u32, min, max, chunk);
                  }
                });
                
                outputlog(&format!("Successfully processed {} remote signals", signals.len()));
              },
              None => {
                outputlog("Warning: No time table available to process remote signals");
              }
            }
          },
          Err(e) => outputlog(&format!("Failed to deserialize final signal: {:?}", e))
        }
      },
      Err(e) => outputlog(&format!("Failed to read signal count: {:?}", e))
    }
  }

  pub fn loadremotechunk(chunk_type: u32, chunk_data: Vec<u8>, chunk_index: u32, total_chunks: u32) {
    let chunk_type_enum = match chunk_type {
      0 => ChunkType::Hierarchy,
      1 => ChunkType::TimeTable,
      2 => ChunkType::Signals,
      _ => {
        outputlog(&format!("Invalid chunk type: {}", chunk_type));
        return;
      }
    };
    Self::handle_chunk(chunk_type_enum, chunk_data, chunk_index, total_chunks);
  }
}