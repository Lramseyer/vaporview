use wellen::{FileFormat, Hierarchy, TimescaleUnit, CompressedTimeTable};
use bincode::Options;

use crate::{BINCODE_OPTIONS, _hierarchy, _file_format, _time_table, _chunks, _total_chunks, get_scope_data, get_var_data, outputlog, setmetadata, setscopetop, setvartop, setchunksize, sendtransitiondatachunk, SurferStatus};

const MAX_CHUNK_SIZE: u32 = 1024 * 32;

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
    let process_fn = match chunk_type {
      ChunkType::Hierarchy => Self::loadremotehierarchy,
      ChunkType::TimeTable => Self::loadremotetimetable,
      ChunkType::Signals => Self::loadremotesignals,
    };
    
    Self::handle_chunk_impl(process_fn, chunk_data, chunk_index, total_chunks);
  }

  fn handle_chunk_impl(
    process_fn: fn(Vec<u8>),
    chunk_data: Vec<u8>,
    chunk_index: u32,
    total_chunks: u32,
  ) {
    let (mut chunks, mut total_chunks_ref) = (
      _chunks.lock().unwrap(),
      _total_chunks.lock().unwrap()
    );
    
    if chunk_index == 0 {
      *total_chunks_ref = total_chunks;
      chunks.clear();
      chunks.resize(total_chunks as usize, Vec::new());
    }
    
    chunks[chunk_index as usize] = chunk_data;
    
    if chunks.iter().all(|chunk| !chunk.is_empty()) {
      let mut reassembled_data = Vec::new();
      for chunk in chunks.iter() {
        reassembled_data.extend_from_slice(chunk);
      }
      process_fn(reassembled_data);
      chunks.clear();
      *total_chunks_ref = 0;
    }
  }

  pub fn loadremotestatus(status_data: Vec<u8>) -> String {
    let status_text = match String::from_utf8(status_data) {
      Ok(text) => text,
      Err(_) => {
        outputlog("Failed to decode status data as UTF-8");
        return "{}".to_string();
      }
    };
    
    let status: SurferStatus = match serde_json::from_str(&status_text) {
      Ok(status) => status,
      Err(e) => {
        outputlog(&format!("Failed to parse status JSON: {:?}", e));
        return "{}".to_string();
      }
    };
    
    outputlog(&format!("Connected to Surfer server: {}", status.filename));
    outputlog(&format!("File format: {}, Wellen version: {}, Surfer version: {}", 
        status.file_format, status.wellen_version, status.surfer_version));
    outputlog(&format!("Bytes loaded: {}/{}", status.bytes_loaded, status.bytes));
    
    status.filename
  }

  pub fn loadremotehierarchy(hierarchy_data: Vec<u8>) {
    let raw = match lz4_flex::decompress_size_prepended(&hierarchy_data) {
      Ok(raw) => raw,
      Err(e) => {
        outputlog(&format!("Failed to decompress hierarchy data: {:?}", e));
        return;
      }
    };
    
    let mut reader = std::io::Cursor::new(raw);
    let opts = BINCODE_OPTIONS.allow_trailing_bytes();
    
    let file_format: FileFormat = match opts.deserialize_from(&mut reader) {
      Ok(format) => format,
      Err(e) => {
        outputlog(&format!("Failed to deserialize file format: {:?}", e));
        return;
      }
    };
    
    let hierarchy: Hierarchy = match BINCODE_OPTIONS.deserialize_from(&mut reader) {
      Ok(hierarchy) => hierarchy,
      Err(e) => {
        outputlog(&format!("Failed to deserialize hierarchy: {:?}", e));
        return;
      }
    };
    
    let mut global_hierarchy = _hierarchy.lock().unwrap();
    let mut global_file_format = _file_format.lock().unwrap();
    *global_hierarchy = Some(hierarchy);
    *global_file_format = file_format;
    
    let hier = global_hierarchy.as_ref().unwrap();
    let scope_count = hier.iter_scopes().count() as u32;
    let var_count = hier.iter_vars().count() as u32;
    
    let time_unit = hier.timescale().map_or("s".to_string(), |scale| {
      match scale.unit {
        TimescaleUnit::ZeptoSeconds => "zs",
        TimescaleUnit::AttoSeconds => "as",
        TimescaleUnit::FemtoSeconds => "fs",
        TimescaleUnit::PicoSeconds => "ps",
        TimescaleUnit::NanoSeconds => "ns",
        TimescaleUnit::MicroSeconds => "us",
        TimescaleUnit::MilliSeconds => "ms",
        TimescaleUnit::Seconds | TimescaleUnit::Unknown => "s",
      }.to_string()
    });
    
    let time_scale = hier.timescale().map_or(1, |scale| scale.factor) as u32;
    setmetadata(scope_count, var_count, time_scale, &time_unit);
    
    for s in hier.scopes() {
      let scope_data = get_scope_data(hier, s);
      setscopetop(&scope_data.name, scope_data.id, &scope_data.tpe);
    }
    
    for v in hier.vars() {
      let var_data = get_var_data(hier, v);
      setvartop(&var_data.name, var_data.id, var_data.signal_id, &var_data.tpe, &var_data.encoding, var_data.width, var_data.msb, var_data.lsb);
    }
    
  }

  pub fn loadremotetimetable(timetable_data: Vec<u8>) {
    let compressed: CompressedTimeTable = match BINCODE_OPTIONS.deserialize(&timetable_data) {
      Ok(compressed) => compressed,
      Err(e) => {
        outputlog(&format!("Failed to deserialize time table: {:?}", e));
        return;
      }
    };
    
    let time_table = compressed.uncompress();
    let mut global_time_table = _time_table.lock().unwrap();
    *global_time_table = Some(time_table);
    
    let tt = global_time_table.as_ref().unwrap();
    let event_count = tt.len();
    
    let min_timestamp = if event_count <= 128 {
      tt[event_count - 1]
    } else {
      (128..event_count)
        .map(|i| tt[i] - tt[i - 128])
        .min()
        .unwrap_or(9999999)
    };
    
    let time_end = tt[event_count - 1];
    let time_end_extend = time_end + (time_end as f32 / event_count as f32).ceil() as u64;
    
    setchunksize(min_timestamp, time_end_extend, event_count as u64);
  }

  pub fn loadremotesignals(signals_data: Vec<u8>) {
    let mut reader = std::io::Cursor::new(signals_data);
    
    let num_ids = match leb128::read::unsigned(&mut reader) {
      Ok(num_ids) => num_ids,
      Err(e) => {
        outputlog(&format!("Failed to read signal count: {:?}", e));
        return;
      }
    };
    
    if num_ids == 0 {
      outputlog("No signals in remote response");
      return;
    }
    
    let opts = BINCODE_OPTIONS.allow_trailing_bytes();
    let mut signals = Vec::new();
    
    // Deserialize all but the last signal with trailing bytes allowed
    for i in 0..(num_ids - 1) {
      let compressed: wellen::CompressedSignal = match opts.deserialize_from(&mut reader) {
        Ok(compressed) => compressed,
        Err(e) => {
          outputlog(&format!("Failed to deserialize signal {}: {:?}", i, e));
          return;
        }
      };
      
      let signal = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| compressed.uncompress())) {
        Ok(signal) => signal,
        Err(_) => {
          outputlog(&format!("Failed to uncompress signal {} (panic caught)", i));
          return;
        }
      };
      
      signals.push((signal.signal_ref(), signal));
    }
    
    // Deserialize the final signal (should consume all remaining bytes)
    let final_compressed: wellen::CompressedSignal = match BINCODE_OPTIONS.deserialize_from(&mut reader) {
      Ok(compressed) => compressed,
      Err(e) => {
        outputlog(&format!("Failed to deserialize final signal: {:?}", e));
        return;
      }
    };
    
    let final_signal = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| final_compressed.uncompress())) {
      Ok(signal) => signal,
      Err(_) => {
        outputlog("Failed to uncompress final signal (panic caught)");
        return;
      }
    };
    
    signals.push((final_signal.signal_ref(), final_signal));
    
    let global_time_table = _time_table.lock().unwrap();
    let time_table = match global_time_table.as_ref() {
      Some(time_table) => time_table,
      None => {
        outputlog("Warning: No time table available to process remote signals");
        return;
      }
    };
    
    for (signal_ref, signal) in signals.iter() {
      let signalid = signal_ref.index() as u32;
      let time_index = signal.time_indices();
      let mut result = String::from("[");
      let mut min = 0.0;
      let mut max = 0.0;
      
      for (i, (_, value)) in signal.iter_changes().enumerate() {
        let v = value.to_string();
        let time = time_table[time_index[i] as usize];
        
        if let wellen::SignalValue::Real(v) = value {
          min = f64::min(min, v);
          max = f64::max(max, v);
        }
        
        result.push_str(&format!("[{:?},{:?}],", time, v));
      }
      
      if result.len() > 1 { result.pop(); }
      result.push(']');
      
      // Send the data in chunks
      let result_length = result.len() as u32;
      let chunk_count = (result_length as f32 / MAX_CHUNK_SIZE as f32).ceil() as u32;
      
      for i in 0..chunk_count {
        let start = (i * MAX_CHUNK_SIZE) as usize;
        let end = std::cmp::min(((i + 1) * MAX_CHUNK_SIZE) as usize, result.len());
        let chunk = &result[start..end];
        sendtransitiondatachunk(signalid, chunk_count, i, min, max, chunk);
      }
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