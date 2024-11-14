// Use a procedural macro to generate bindings for the world we specified in
// `host.wit`

wit_bindgen::generate!({
  // the name of the world in the `*.wit` input file
  world: "filehandler",
});

use std::io::{self, BufReader, Cursor, Read, Seek, SeekFrom};
use lazy_static::lazy_static;
use std::sync::Mutex;
use wellen::{FileFormat, GetItem, Hierarchy, ScopeRef, SignalRef, SignalSource, TimeTable, TimescaleUnit, WellenError};
use wellen::viewers::{read_body, read_header, ReadBodyContinuation, HeaderResult};
use wellen::LoadOptions;
use std::sync::Arc;

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

  static ref _file_format : Mutex<FileFormat> = Mutex::new(FileFormat::Unknown);
  static ref _hierarchy: Mutex<Option<Hierarchy>> = Mutex::new(None);
  static ref _body: Mutex<ReadBodyEnum> = Mutex::new(ReadBodyEnum::None);
  static ref _time_table: Mutex<Option<TimeTable>> = Mutex::new(None);
  static ref _signal_source: Mutex<Option<SignalSource>> = Mutex::new(None);
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
      log(&format!("Invalid seek to negative position: {:?}", new_cursor));
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
      log(&format!("Invalid seek to negative position: {:?}", new_cursor));
      self.cursor = 0;
      return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid seek to negative position"));
    }
    self.cursor = std::cmp::min(new_cursor, self.file_size as i64) as u64;
    Ok(())
  }
}

struct Filecontext;

impl Guest for Filecontext {

  fn loadfile(size: u64, fd: u32, loadstatic: bool) {

    //log(&format!("Loading file from bytes: {:?}", size));
    //let loadstatic = false;

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
      let file_reader = BufReader::new(reader);
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
        log(&format!("Error reading header: {:?}", e));
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
      let scope = hierarchy.get(s);
      log(&format!("ID: {:?} Scope: {:?}", s, scope));
      let name = scope.name(&hierarchy).to_string();
      let tpe = format!("{:?}", scope.scope_type());

      setscopetop(&name, s.index() as u32, &tpe);
    }

    for v in hierarchy.vars() {
      let variable = hierarchy.get(v);
      log(&format!("Item: {:?}", variable));
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

    log(&format!("Done reading body"));

    match body_result {
      Ok(result) => {
        *global_time_table = Some(result.time_table);
        *global_signal_source = Some(result.source);
      },
      Err(e) => {
        log(&format!("Error reading body: {:?}", e));
        return;
      }
    }

    let time_table = global_time_table.as_ref().unwrap();
    let mut min_timestamp = 9999999;
    let event_count = time_table.len();
    let time_table_length = time_table.len(); 
    let time_end = time_table[time_table_length - 1];
    let time_end_extend = time_end + (time_end as f32 / time_table_length as f32).ceil() as u64;
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

    setchunksize(min_timestamp, time_end_extend);

    // unload _body
    *global_body = ReadBodyEnum::None;
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
      Some(parent_ref) => {parent_scope = hierarchy.get(parent_ref);},
      None => {log(&format!("No scopes found")); return "{\"scopes\": [], \"vars\": []}".to_string();}
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

      let scope = hierarchy.get(s);
      let name = scope.name(&hierarchy).to_string();
      let id = s.index();
      let tpe = format!("{:?}", scope.scope_type());
      let scope_string = format!("{{\"name\": {:?},\"id\": {:?},\"type\": {:?}}}", name, id, tpe);
      
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

      let var = hierarchy.get(v);
      let name = var.name(&hierarchy).to_string();
      let id = v.index();
      let tpe = format!("{:?}", var.var_type());
      let width = var.length().unwrap_or(0);
      let signal_ref = var.signal_ref().index();
      let mut msb: i32 = -1;
      let mut lsb: i32 = -1;
      let bits = var.index();
      match bits {
        Some(b) => {msb = b.msb() as i32; lsb = b.lsb() as i32;},
        None => {}
      }
      let var_string = format!("{{\"name\": {:?},\"netlistId\": {:?},\"signalId\": {:?},\"type\": {:?},\"width\": {:?}, \"msb\": {:?}, \"lsb\": {:?}}}", name, id, signal_ref, tpe, width, msb, lsb);
      
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

  fn getsignaldata(signalid: u32) {
    //log(&format!("Getting signal data for signal: {:?}", signalid));
    let mut result = String::new();
    result.push_str("[");

    let mut global_signal_source = _signal_source.lock().unwrap();
    let signal_source = global_signal_source.as_mut().unwrap();

    let global_hierarchy = _hierarchy.lock().unwrap();
    let hierarchy = global_hierarchy.as_ref().unwrap();

    let global_time_table = _time_table.lock().unwrap();
    let time_table = global_time_table.as_ref().unwrap();

    let signal_ref_option = SignalRef::from_index(signalid as usize);
    let signal_ref;

    match signal_ref_option {
      Some(s) => {signal_ref = s},
      None => {
        log(&format!("Signal not found"));
        result.push_str("]");
        sendtransitiondatachunk(signalid, 1, 0, result.as_str());
        return;
      }
    }

    let signal_loaded = signal_source.load_signals(&[signal_ref], hierarchy, false);
    let signal = &signal_loaded[0].1;

    //log(&format!("Loaded Signal! "));

    let transitions = signal.iter_changes();
    let time_index = signal.time_indices();

    //log(&format!("Total Time Indices: {:?}", time_index.len()));
    let mut i: usize = 0;
    for (_, value) in transitions {
      match value.to_bit_string() {
        Some(v) => {
        
          let time = time_table[time_index[i] as usize];
          result.push_str(&format!("[{:?},{:?}],", time, v));
          //result.push_str(&format!("[{:?},{:?}],", time_index[i], v));
          //result.push_str(&format!("{:?},", v));
          i += 1;
        },
        None => {}
      }
    }

    //log(&format!("Signal Data Orgainzed!"));

    // set last character to "]" to close the array
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
      //log(&format!("Sending chunk: {:?} for {:?}", i, signalid));
      sendtransitiondatachunk(signalid, chunk_count, i as u32, chunk);
    }

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