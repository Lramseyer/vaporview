// Use a procedural macro to generate bindings for the world we specified in
// `host.wit`

wit_bindgen::generate!({
  // the name of the world in the `*.wit` input file
  world: "filehandler",
});

use std::io::{self, BufReader, Cursor, Read, Seek, SeekFrom, Write};
//use std::result;
use lazy_static::lazy_static;
use std::sync::Mutex;
use std::sync::Arc;
use std::cmp::max;
use wellen::{FileFormat, Hierarchy, ScopeRef, Signal, SignalRef, SignalSource, TimeTable, TimescaleUnit, WellenError, VarRef};
use wellen::viewers::{read_body, read_header, ReadBodyContinuation, HeaderResult};
use wellen::LoadOptions;
use core::ops::Index;
use lz4_flex::frame::FrameEncoder;
use serde::Deserialize;

mod libsurfer;


#[derive(Deserialize, Debug)]
pub struct SurferStatus {
    bytes: u64,
    bytes_loaded: u64,
    filename: String,
    wellen_version: String,
    surfer_version: String,
    file_format: String,
}

enum ReadBodyEnum {
  Static(ReadBodyContinuation<Cursor<Vec<u8>>>),
  Dynamic(ReadBodyContinuation<BufReader<WasmFileReader>>),
  None,
}

enum HeaderResultType {
  Static(HeaderResult<Cursor<Vec<u8>>>),
  Dynamic(HeaderResult<BufReader<WasmFileReader>>),
  Err(WellenError),
}

lazy_static! {
  //static ref _file: Mutex<Option<WasmFileReader>> = Mutex::new(None);
  pub static ref BINCODE_OPTIONS: bincode::DefaultOptions = bincode::DefaultOptions::new();
  static ref _file_format : Mutex<FileFormat> = Mutex::new(FileFormat::Unknown);
  static ref _hierarchy: Mutex<Option<Hierarchy>> = Mutex::new(None);
  static ref _body: Mutex<ReadBodyEnum> = Mutex::new(ReadBodyEnum::None);
  static ref _time_table: Mutex<Option<TimeTable>> = Mutex::new(None);
  static ref _signal_source: Mutex<Option<SignalSource>> = Mutex::new(None);
  static ref _param_table: Mutex<Option<Vec<(u32, String)>>> = Mutex::new(None);
  
  // Chunked data reassembly
  static ref _chunks: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());
  static ref _total_chunks: Mutex<u32> = Mutex::new(0);
}

struct WasmFileReader {
  fd: u32,
  file_size: u64,
  cursor: u64,
  read_callback: Arc<dyn Fn(u32, u64, u32) -> Vec<u8> + Send + Sync>,
}

impl WasmFileReader {
  fn new(fd: u32, file_size: u64) -> Self {
    //let file_size = getsize(fd);
    let read_callback = Arc::new(|fd, cursor, size| {fsread(fd, cursor, size)});
    let reader = WasmFileReader { fd, file_size, cursor: 0, read_callback };
    reader
  }
}

#[derive(Deserialize, Debug)]
pub struct VarData {
  name: String,
  id: u32,
  signal_id: u32,
  var_type: String,
  encoding: String,
  width: u32,
  msb: i32,
  lsb: i32,
  enum_name: String,
  param_value: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct ScopeData {
  name: String,
  id: u32,
  tpe: String,
}

pub fn get_var_data(hierarchy: &Hierarchy, v: VarRef) -> VarData {

  let variable = hierarchy.index(v);
  let name = variable.name(&hierarchy).to_string();
  let id = v.index() as u32;
  let tpe = variable.var_type();
  let var_type = format!("{:?}", tpe);
  let encoding = format!("{:?}", variable.signal_encoding());
  let width = variable.length().unwrap_or(0);
  let signal_ref = variable.signal_ref();
  let signal_id = signal_ref.index() as u32;
  let mut msb: i32 = -1;
  let mut lsb: i32 = -1;
  let bits = variable.index();
  let enum_type = variable.enum_type(&hierarchy);
  match bits {
    Some(b) => {msb = b.msb() as i32; lsb = b.lsb() as i32;},
    None => {}
  }

  let enum_name = match enum_type {
    Some(e) => e.0.to_string(),
    None => "".to_string(),
  };

  let mut param_value: Option<String> = None;
  if tpe == wellen::VarType::Parameter {
    param_value = get_parameter_value(signal_id);
    //log(&format!("Parameter {} value: {:?}", name, param_value));
  }
  VarData { name, id, signal_id, var_type, encoding, width, msb, lsb, enum_name, param_value }
}

pub fn get_scope_data(hierarchy: &Hierarchy, s: ScopeRef) -> ScopeData {
  let scope = hierarchy.index(s);
  let name = scope.name(&hierarchy).to_string();
  let id = s.index() as u32;
  let tpe = format!("{:?}", scope.scope_type());
  ScopeData { name, id, tpe }
}

fn load_parameters() {
  let mut global_signal_source = _signal_source.lock().unwrap();
  let signal_source = global_signal_source.as_mut().unwrap();

  let global_hierarchy = _hierarchy.lock().unwrap();
  let hierarchy = global_hierarchy.as_ref().unwrap();

  let signal_list = hierarchy.iter_vars()
    .filter(|var| {var.var_type() == wellen::VarType::Parameter})
    .map(|var| {var.signal_ref()});

  let signal_data = signal_source.load_signals(&signal_list.collect::<Vec<SignalRef>>(), hierarchy, false);
  let param_table_option = signal_data.iter().map(|(s, signal)| {
    let index = signal.get_first_time_idx();
    let data_offset = match index {
      Some(i) => signal.get_offset(i),
      None => None
    };
    let value= match data_offset {
      Some(offset) => Some(signal.get_value_at(&offset, 0)),
      None => None
    };
    (s, value)
  });
  let param_table = param_table_option.filter(|(_, v)| {v.is_some()})
    .map(|(s, v)| {(s.index() as u32, v.unwrap().to_string())})
    .collect::<Vec<(u32, String)>>();

  let mut global_param_table = _param_table.lock().unwrap();
  *global_param_table = Some(param_table);
}

fn get_parameter_value(signalid: u32) -> Option<String> {
  let global_param_table = _param_table.lock().unwrap();
  let param_table = global_param_table.as_ref();
  if param_table.is_none() {
    return None;
  } else {
    let param_table = param_table.unwrap();
    for (id, value) in param_table.iter() {
      if *id == signalid {
        return Some(value.clone());
      }
    }
  }
  None
}


fn send_enum_data(name: &str, values: &str) {
  let max_return_length = 65000;
  let result_length = values.len();
  let chunk_count = (result_length as f32 / max_return_length as f32).ceil() as u32;
  for i in 0..chunk_count {
    let start = i * max_return_length;
    let end = std::cmp::min((i + 1) * max_return_length, result_length as u32);
    let chunk = &values[start as usize..end as usize];
    sendenumdata(name, chunk_count, i, chunk);
  }
}

fn parse_value_change_data_json(signal: &Signal, time_index: &[u32], signalid: u32) {
  let global_time_table = _time_table.lock().unwrap();
  let time_table = global_time_table.as_ref().unwrap();
  let transitions = signal.iter_changes();

  let mut i: usize = 0;
  let mut min: f64 = 0.0;
  let mut max: f64 = 0.0;
  let mut result = String::new();
  result.push_str("[");
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
  }
  //log(&format!("Signal Data Orgainzed!"));
  // set last character to "]" to close the array
  if result.len() > 1 {result.pop();}
  result.push_str("]");

  // Fallback to uncompressed chunks
  let max_return_length = 65000;
  let result_length = result.len();
  let chunk_count = (result_length as f32 / max_return_length as f32).ceil() as u32;
  for i in 0..chunk_count {
    let start = i * max_return_length;
    let end = std::cmp::min((i + 1) * max_return_length, result_length as u32);
    let chunk = &result[start as usize..end as usize];
    sendtransitiondatachunk(signalid, chunk_count, i as u32, min, max, chunk);
  }
}

fn parse_value_change_data_lz4(signal: &Signal, time_index: &[u32], signalid: u32) {
  let global_time_table = _time_table.lock().unwrap();
  let time_table = global_time_table.as_ref().unwrap();

  let transitions = signal.iter_changes();

  let mut i: usize = 0;
  let mut min: f64 = 0.0;
  let mut max: f64 = 0.0;
  let mut result = Vec::<u8>::new();
  let mut prev_time = 0;
  let mut v: String = String::new();

  for (_, value) in transitions {
    v = value.to_string();
    let time = time_table[time_index[i] as usize];
    let delta_time = time - prev_time;
    match value {
      wellen::SignalValue::Real(v) => {
        min = f64::min(min, v);
        max = f64::max(max, v);
      },
      _ => {}
    }
    // store u64 as raw bytes (8 bytes in little-endian format)
    let delta_time_bytes = delta_time.to_le_bytes();
    result.extend_from_slice(&delta_time_bytes);
    result.extend_from_slice(v.as_bytes());

    prev_time = time;
    i += 1;
  }
  let width = v.len() as u32;

  // Try LZ4 compression first, fallback to uncompressed if compression doesn't help or fails
  let original_size = result.len();

  match std::panic::catch_unwind(|| {
    let mut encoder = FrameEncoder::new(Vec::new());
    encoder.write_all(&result).unwrap();
    encoder.finish().unwrap()
  }) {
    Ok(compressed_data) => {

      let max_chunk_size = 65000;
      let compressed_length = compressed_data.len();
      let chunk_count_float = (compressed_length as f32) / (max_chunk_size as f32);
      let chunk_count = chunk_count_float.ceil() as u32;

      for i in 0..chunk_count {
        let start = i as usize * max_chunk_size;
        let end = std::cmp::min((i + 1) as usize * max_chunk_size, compressed_length);
        let chunk = &compressed_data[start..end];
        sendcompressedtransitiondata(signalid, width, chunk_count, i as u32, min, max, chunk, original_size as u32);
      }
      return; // Exit early if compression was used
    },
    Err(_) => {
      outputlog(&format!("LZ4 compression failed for signal {}, falling back to uncompressed", signalid));
    }
  }
}

impl Read for WasmFileReader {
  fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
    //log(&format!("Reading data from offset: {:?}, size: {:?}", self.cursor, buf.len()));

    let mut bytes_read = 0;
    let read_size = std::cmp::min(buf.len() as u32, self.file_size as u32 - self.cursor as u32) as usize;
    while bytes_read < read_size {
      let chunk_size = std::cmp::min(read_size - bytes_read, 32768);
      let data = (self.read_callback)(self.fd, self.cursor, chunk_size as u32);
      buf[bytes_read..bytes_read + chunk_size].copy_from_slice(&data);
      self.cursor += chunk_size as u64;
      bytes_read += chunk_size;
    }
    Ok(bytes_read)
  }

  fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
    //log(&format!("Reading exact data from offset: {:?}, size: {:?}", self.cursor, buf.len()));
    let bytes_read = self.read(buf);
    match bytes_read {
      Ok(size) => {
        if size == buf.len() {Ok(())}
        else {Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Failed to read all bytes"))}
      },
      Err(e) => Err(e),
    }
  }
}

impl Seek for WasmFileReader {
  fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
    //log(&format!("Seeking to: {:?}", pos));
    let new_cursor;
    match pos {
      SeekFrom::Start(offset) => { new_cursor = offset; }
      SeekFrom::End(offset) => { new_cursor = (self.file_size as i64 + offset) as u64; }
      SeekFrom::Current(offset) => { new_cursor = (self.cursor as i64 + offset) as u64; }
    }
    if (new_cursor as i64) < 0 {
      outputlog(&format!("Invalid seek to negative position: {:?}", new_cursor));
      self.cursor = 0;
      return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid seek to negative position"));
    }
    self.cursor = std::cmp::min(new_cursor, self.file_size);
    Ok(self.cursor)
  }

  fn rewind(&mut self) -> io::Result<()> {
    //log(&format!("Rewinding file"));
    self.cursor = 0;
    Ok(())
  }

  fn stream_position(&mut self) -> io::Result<u64> {Ok(self.cursor)}

  fn seek_relative(&mut self, offset: i64) -> io::Result<()> {
    //log(&format!("Seeking relative: {:?}", offset));
    let new_cursor = (self.cursor as i64 + offset) as i64;
    if new_cursor < 0 {
      outputlog(&format!("Invalid seek to negative position: {:?}", new_cursor));
      self.cursor = 0;
      return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid seek to negative position"));
    }
    self.cursor = std::cmp::min(new_cursor, self.file_size as i64) as u64;
    Ok(())
  }
}

struct Filecontext;

impl Guest for Filecontext {

  fn loadremotestatus(status_data: Vec<u8>) -> String {
    libsurfer::SurferRemote::loadremotestatus(status_data)
  }

  fn loadremotechunk(chunk_type: u32, chunk_data: Vec<u8>, chunk_index: u32, total_chunks: u32) {
    libsurfer::SurferRemote::loadremotechunk(chunk_type, chunk_data, chunk_index, total_chunks);
  }

  fn loadfile(size: u64, fd: u32, loadstatic: bool, buffersize: u32) {

    //log(&format!("Loading file from bytes: {:?}", size));

    let options = LoadOptions {
      multi_thread: false, // WASM is currently single-threaded
      remove_scopes_with_empty_name: false,
    };

    let header_result: HeaderResultType;
    let mut reader = WasmFileReader::new(fd, size);

    if loadstatic {
      // Load a file statically into memory
      let mut file = vec![0; size as usize];
      reader.read(&mut file).unwrap();
      let file_reader = Cursor::new(file);
      let result = read_header(file_reader, &options);
      header_result = match result {
        Ok(header) => HeaderResultType::Static(header),
        Err(e) => HeaderResultType::Err(e),
      };
    } else {
      //let file_reader = BufReader::new(reader);
      let file_reader = BufReader::with_capacity(buffersize as usize, reader);
      let result = read_header(file_reader, &options);
      header_result = match result {
        Ok(header) => HeaderResultType::Dynamic(header),
        Err(e) => HeaderResultType::Err(e),
      };
    }

    //log(&format!("Done reading file data"));

    //let mut contents = file_contents.lock().unwrap();
    let mut global_hierarchy = _hierarchy.lock().unwrap();
    let mut global_body = _body.lock().unwrap();
    let mut global_file_format = _file_format.lock().unwrap();

    match header_result {
      HeaderResultType::Dynamic(header) => {
        *global_hierarchy = Some(header.hierarchy);
        *global_file_format = header.file_format;
        *global_body = ReadBodyEnum::Dynamic(header.body);
      },
      HeaderResultType::Static(header) => {
        *global_hierarchy = Some(header.hierarchy);
        *global_file_format = header.file_format;
        *global_body = ReadBodyEnum::Static(header.body);
      },
      HeaderResultType::Err(e) => {
        outputlog(&format!("Error reading header: {:?}", e));
        return;
      }
    }

    //log(&format!("Done loading File"));

    let hierarchy = global_hierarchy.as_ref().unwrap();

    // count the number of scopes and vars
    let scope_count = hierarchy.iter_scopes().count() as u32;
    let var_count = hierarchy.iter_vars().count() as u32;
    let time_scale_data = hierarchy.timescale();
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

    for s in hierarchy.scopes() {
      let scope_data = get_scope_data(&hierarchy, s);
      setscopetop(&scope_data.name, scope_data.id, &scope_data.tpe);
    }

    for v in hierarchy.vars() {
      let var_data = get_var_data(&hierarchy, v);
      setvartop(&var_data.name, var_data.id, var_data.signal_id, &var_data.var_type, &var_data.encoding, var_data.width, var_data.msb, var_data.lsb, &var_data.enum_name);
    }
  }

  fn readbody() {

    //log(&format!("Reading body..."));

    let global_hierarchy = _hierarchy.lock().unwrap();
    let hierarchy = global_hierarchy.as_ref().unwrap();
    let mut global_body = _body.lock().unwrap();
    let mut global_time_table = _time_table.lock().unwrap();
    let mut global_signal_source = _signal_source.lock().unwrap();
    let body = std::mem::replace(&mut *global_body, ReadBodyEnum::None);
    let body_result;

    body_result = match body {
      ReadBodyEnum::Dynamic(body) => {
        read_body(body, hierarchy, None)
      },
      ReadBodyEnum::Static(body) => {
        read_body(body, hierarchy, None)
      },
      ReadBodyEnum::None => {
        Err(WellenError::FailedToLoad(FileFormat::Unknown, "No body found".to_string()))
      }
    };

    //log(&format!("Done reading body"));

    match body_result {
      Ok(result) => {
        *global_time_table = Some(result.time_table);
        *global_signal_source = Some(result.source);
      },
      Err(e) => {
        outputlog(&format!("Error reading body: {:?}", e));
        return;
      }
    }

    // Drop only the mutex guards that would cause deadlock in load_parameters
    drop(global_hierarchy);
    drop(global_signal_source);
    load_parameters();

    let time_table = global_time_table.as_ref().unwrap();
    let mut min_timestamp = 9999999;
    let event_count = time_table.len();
    let time_table_length = time_table.len(); 
    let time_end = time_table[time_table_length - 1];
    let time_extend = max((time_end as f32 / time_table_length as f32).ceil() as u64, 1);
    let time_end_extend = time_end + time_extend;
    //log(&format!("Event count: {:?}", event_count));
    if event_count <= 128 {
      min_timestamp = time_table[event_count - 1];
    } else {
      for i in 128..event_count {
        let rolling_time_step = time_table[i] - time_table[i - 128];
        min_timestamp = std::cmp::min(rolling_time_step, min_timestamp);
      }
    }
    //log(&format!("Setting chunk size to: {:?}", min_timestamp));
    // convert time_table_length to string with commas

    setchunksize(min_timestamp, time_end_extend, time_table_length as u64);

    // unload _body
    *global_body = ReadBodyEnum::None;
  }

  fn getparametervalues(signalidlist: Vec<u32>) -> String {
    let mut result: Vec<(u32, String)> = Vec::new();
    signalidlist.iter().for_each(|signalid| {
      let param_value = get_parameter_value(*signalid);
      if param_value.is_some() {
        result.push((*signalid, param_value.unwrap()));
      }
    });
    // convert result to JSON string
    let result_string = serde_json::to_string(&result);
    log(result_string.as_ref().unwrap());
    return result_string.unwrap_or("[]".to_string());
  }

  // returns a JSON string of the children of the given path
  // Since WASM is limited to 64K memory, we need to limit the return size
  // and allow the function to be called multiple times to get all the data
  fn getchildren(id: u32, startindex: u32) -> String {

    let global_hierarchy = _hierarchy.lock().unwrap();
    let hierarchy = global_hierarchy.as_ref().unwrap();

    let parent_scope;
    let parent = ScopeRef::from_index(id as usize);
    match parent {
      Some(parent_ref) => {parent_scope = hierarchy.index(parent_ref);},
      None => {outputlog(&format!("No scopes found")); return "{\"scopes\": [], \"vars\": []}".to_string();}
    }

    //log(&format!("Parent Scope: {:?}", parent));

    let max_return_length = 65000;
    let mut result = String::from("{\"scopes\": [");
    let mut index = 0;
    let mut return_length = result.len() as u32;
    let mut child_scopes_string: Vec<String> = Vec::new();
    let mut items_returned = 0;
    let child_scopes = parent_scope.scopes(&hierarchy);
    let mut total_scopes = 0;

    for s in child_scopes {
      total_scopes += 1;
      if (index < startindex) || (return_length > max_return_length) {index+=1; continue;}
      index+=1;

      let scope_data = get_scope_data(&hierarchy, s);
      let scope_string = format!("{{\"name\": {:?},\"id\": {:?},\"type\": {:?}}}", scope_data.name, scope_data.id, scope_data.tpe);

      items_returned += 1;
      return_length += (scope_string.len() as u32) + 1;
      child_scopes_string.push(scope_string);
    }

    result.push_str(&child_scopes_string.join(","));
    result.push_str("], \"vars\": [");

    let child_vars = parent_scope.vars(&hierarchy);
    let mut child_vars_string: Vec<String> = Vec::new();
    let mut total_vars = 0;

    for v in child_vars {
      total_vars += 1;
      if (index < startindex) || (return_length > max_return_length) {index+=1; continue;}
      index+=1;

      let var_data = get_var_data(&hierarchy, v);
      let param_value = match &var_data.param_value {
        Some(v) => v.clone(),
        None => "".to_string(),
      };
      let var_string = format!("{{\"name\": {:?},\"netlistId\": {:?},\"signalId\": {:?},\"type\": {:?},\"encoding\": {:?}, \"width\": {:?}, \"msb\": {:?}, \"lsb\": {:?}, \"enumType\": {:?}, \"paramValue\": {:?}}}", var_data.name, var_data.id, var_data.signal_id, var_data.var_type, var_data.encoding, var_data.width, var_data.msb, var_data.lsb, var_data.enum_name, param_value);

      items_returned += 1;
      return_length += (var_string.len() as u32) + 1;
      child_vars_string.push(var_string);
    }

    let total_items = total_scopes + total_vars;
    let remaining_items = total_items - (items_returned + startindex);

    result.push_str(&child_vars_string.join(","));
    result.push_str(format!("],\"totalReturned\": {:?},\"remainingItems\": {:?}}}", items_returned, remaining_items).as_str());
    result
  }

  fn getsignaldata(signalidlist: Vec<u32>) {
    //log(&format!("Getting signal data for signal: {:?}", signalid));

    let mut global_signal_source = _signal_source.lock().unwrap();
    let signal_source = global_signal_source.as_mut().unwrap();

    let global_hierarchy = _hierarchy.lock().unwrap();
    let hierarchy = global_hierarchy.as_ref().unwrap();

    let mut signal_ref_list: Vec<SignalRef> = Vec::new();
    signalidlist.iter().for_each(|signalid| {

      let signal_ref_option = SignalRef::from_index(*signalid as usize);
      match signal_ref_option {
        Some(s) => {signal_ref_list.push(s);},
        None => {
          outputlog(&format!("Signal not found: {}", signalid));
          sendtransitiondatachunk(*signalid, 1, 0, 0.0, 1.0, "[]");
          return;
        }
      }
    });

    let signals_loaded = signal_source.load_signals(&signal_ref_list, hierarchy, false);
    signals_loaded.iter().for_each(|(s, signal)| {

      let signalid = s.index() as u32;
      let time_index = signal.time_indices();
      let value_changes = time_index.len();
      let data_offset = signal.get_offset(0);

      // Find out if the signal data is a real or string
      let width = match data_offset {
        Some(offset) => {
          let value = signal.get_value_at(&offset, 0);
          let bits = value.bits();
          match bits {
            Some(b) => b,
            None => 0,
          }
        }, None => 0
      };
      let vc_data_size = (value_changes as u32) * (width + 8);
      // We only want to use compression on bit vectors with lots of value changes
      let use_compression = (width > 0) && (vc_data_size > 65000);

      if use_compression {
        parse_value_change_data_lz4(signal, &time_index, signalid);
      } else {
        parse_value_change_data_json(signal, &time_index, signalid);
      }
      //log(&format!("Signal Data Sent!"));
    });

  }

  fn getenumdata(netlistidlist: Vec<u32>) {
    let global_hierarchy = _hierarchy.lock().unwrap();
    let hierarchy = global_hierarchy.as_ref().unwrap();

    log(&format!("Getting enum data for netlist IDs: {:?}", netlistidlist));

    netlistidlist.iter().for_each(|netlistid| {
      let var_ref_option = VarRef::from_index(*netlistid as usize);
      match var_ref_option {
        Some(var_ref) => {
          let variable = hierarchy.index(var_ref);
          let enum_data = variable.enum_type(&hierarchy);
          match enum_data {
            Some(data) => {
              let name = data.0.to_string();
              let values = data.1;
              serde_json::to_string(&values).map_or_else(
                |err| {outputlog(&format!("Error serializing enum values for {}: {:?}", name, err));},
                |json| {send_enum_data(&name, &json);}
              );
            },
            None => {return;}
          }
        },
        None => {return;}
      }
  
    });
  }

  fn getvaluesattime(time: u64, paths: String) -> String {

    let mut global_signal_source = _signal_source.lock().unwrap();
    let signal_source = global_signal_source.as_mut().unwrap();

    let global_hierarchy = _hierarchy.lock().unwrap();
    let hierarchy = global_hierarchy.as_ref().unwrap();

    let global_time_table = _time_table.lock().unwrap();
    let time_table = global_time_table.as_ref().unwrap();

    let mut signal_ref_list: Vec<SignalRef> = Vec::new();
    let mut result_struct: Vec<(String, SignalRef)> = Vec::new();

    let path_list = paths.split(" ").collect::<Vec<&str>>();
    path_list.iter().for_each(|path| {
      let path_parts: Vec<&str> = path.split('.').collect();
      let name = path_parts.last().unwrap();
      let scope_path = &path_parts[0..path_parts.len() - 1];
      let var_ref_option = hierarchy.lookup_var(&scope_path, name);
      match var_ref_option {
        Some(s) => {
          let var = hierarchy.index(s);
          let signal_ref = var.signal_ref();
          signal_ref_list.push(signal_ref);
          result_struct.push((path.to_string(), signal_ref));
        },
        None => {return;}
      }
    });

    //log(&format!("Signal Ref List: {:?}", signal_ref_list));

    let signals_loaded = signal_source.load_signals(&signal_ref_list, hierarchy, false);

    let mut result = String::new();
    result.push_str("[");
    signals_loaded.iter().for_each(|(s, signal)| {
      let transitions = signal.iter_changes();
      let time_index = signal.time_indices();

      //log(&format!("Total Time Indices: {:?}", time_index.len()));
      let mut i: usize = 0;
      let mut v = "[]".to_string();
      let mut last_value = None;

      for (_, value) in transitions {
          let current_time = time_table[time_index[i] as usize];
          if current_time > time {
              if let Some(ref last) = last_value {
                  v = format!("[\"{}\"]", last);
              }
              break;
          }
          if current_time == time {
              if let Some(ref last) = last_value {
                v = format!("[\"{}\"", last);
              }
              v.push_str(&format!(",\"{}\"]", value.to_string()));
              break;
          }
          last_value = Some(value.to_string());
          i += 1;
      }

      if v == "[]" && last_value.is_some() {
          v = format!("[\"{}\"]", last_value.unwrap());
      }

      result_struct.iter().for_each(|(path, signalid)| {
        if s.index() == signalid.index() {
          result.push_str(&format!("{{\"instancePath\": {:?}, \"value\": {:?}}},", path, v));
        }
      });

      // Send the data in chunks
    });
    
    if result.len() > 1 {result.pop();}
    result.push_str("]");
    return result;

  }

  fn unload() {
    let mut global_signal_source = _signal_source.lock().unwrap();
    let mut global_time_table = _time_table.lock().unwrap();
    let mut global_body = _body.lock().unwrap();
    let mut global_hierarchy = _hierarchy.lock().unwrap();
    let mut global_file_format = _file_format.lock().unwrap();
    *global_signal_source = None;
    *global_time_table = None;
    *global_body = ReadBodyEnum::None;
    *global_hierarchy = None;
    *global_file_format = FileFormat::Unknown;
  }
}

// Export the Filecontext to the extension code.
export!(Filecontext);
