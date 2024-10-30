// Use a procedural macro to generate bindings for the world we specified in
// `host.wit`

wit_bindgen::generate!({
  // the name of the world in the `*.wit` input file
  world: "filehandler",
});

use std::io::{self, Read, Seek, SeekFrom};
use lazy_static::lazy_static;
use std::sync::Mutex;
use wellen::{simple, FileFormat, GetItem, Hierarchy, HierarchyItem, ScopeRef, ScopeType, VarRef, SignalRef, SignalSource, TimeTable};
use wellen::viewers::{HeaderResult, read_header_from_bytes, read_body, ReadBodyContinuation};
use wellen::LoadOptions;

lazy_static! {
  static ref WASM_FILE_READER: Mutex<Option<WasmFileReader>> = Mutex::new(None);
  static ref DUMMY_ITERATOR: Mutex<Option<i32>> = Mutex::new(None);

  static ref _file_format : Mutex<Option<FileFormat>> = Mutex::new(None);
  static ref _hierarchy: Mutex<Option<Hierarchy>> = Mutex::new(None);
  static ref _body: Mutex<Option<ReadBodyContinuation>> = Mutex::new(None);
  static ref _time_table: Mutex<Option<TimeTable>> = Mutex::new(None);
  static ref _signal_source: Mutex<Option<SignalSource>> = Mutex::new(None);
}

// Not sure if these work yet...
struct WasmFileReader {
  fd: u32,
  offset: u64,
  size: u64,
}

impl WasmFileReader {
  fn new(fd: u32) -> Self {
    let size = getsize(fd);
    WasmFileReader { fd, offset: 0, size }
  }
}

impl Read for WasmFileReader {
  fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
    let length = buf.len() as u32;
    let data = fsread(self.fd, self.offset, length);
    let bytes_read = data.len();
    buf[..bytes_read].copy_from_slice(&data);
    self.offset += bytes_read as u64;
    Ok(bytes_read)
  }
}

impl Seek for WasmFileReader {
  fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
    match pos {
      SeekFrom::Start(offset) => {self.offset = offset;}
      SeekFrom::End(offset) => {self.offset = (self.size as i64 + offset) as u64;}
      SeekFrom::Current(offset) => {self.offset = (self.offset as i64 + offset) as u64;}
    }
    Ok(self.offset)
  }
}

struct Filecontext;

impl Guest for Filecontext {

  fn createfilereader(fd: u32) {
    let mut wasm_file_reader = WASM_FILE_READER.lock().unwrap();
    *wasm_file_reader = Some(WasmFileReader::new(fd));
  }

  fn newiterator() {
    let mut dummy_iterator = DUMMY_ITERATOR.lock().unwrap();
    *dummy_iterator = Some(0);
  }

  fn incrementiterator() {
    let mut dummy_iterator = DUMMY_ITERATOR.lock().unwrap();
    if let Some(ref mut i) = *dummy_iterator {
      *i += 1;
    }
    log(&format!("Incremented iterator: {:?}", *dummy_iterator));
  }

  fn test(fd: u32, offset: u64) {

    log(&format!("Reading 4k at offset: {:?}", offset));
    log(&format!("File descriptor: {:?}", fd));

    let rdata = fsread(fd, offset, 128);

    // For example, convert to a string if it's text data
    let data_str = String::from_utf8_lossy(&rdata);
    log(&format!("Read data as string: {:?}", data_str));
  }

  fn loadfst(size: u32, fd: u32) {

    log(&format!("Loading FST from bytes: {:?}", size));

    // create a new vector of the file size to hold the file data
    let mut file = vec![0; size as usize];

    // read the file data in 32K chunks into the vector
    let mut offset = 0;
    let chunk_size = 32768;
    while offset < size as usize {
      let read_size = std::cmp::min(chunk_size, size as usize - offset);
      let chunk = fsread(fd, offset as u64, read_size as u32);
      let chunk_len = chunk.len();
      file[offset..offset + chunk_len].copy_from_slice(&chunk);
      offset += chunk_len;
    }

    log(&format!("Done reading file data"));

    let options = LoadOptions {
      multi_thread: true, // WASM is currently single-threaded
      remove_scopes_with_empty_name: false,
    };
    //let mut contents = file_contents.lock().unwrap();
    let mut global_hierarchy = _hierarchy.lock().unwrap();
    let mut global_body = _body.lock().unwrap();
    let mut global_file_format = _file_format.lock().unwrap();

    // Use wellen to read the FST file
    let result = read_header_from_bytes(file, &options);

    match result {
      Ok(header) => {
        //*contents = Some(header);
        *global_hierarchy = Some(header.hierarchy);
        *global_body = Some(header.body);
        *global_file_format = Some(header.file_format);

        log(&format!("Successfully loaded FST"));
      },
      Err(e) => {log(&format!("Error loading FST: {:?}", e)); return;}
    }

    let hierarchy = global_hierarchy.as_ref().unwrap();

    for s in hierarchy.scopes() {
      let scope = hierarchy.get(s);
      log(&format!("ID: {:?} Scope: {:?}", s, scope));
      let name = scope.name(&hierarchy).to_string();
      let tpe = format!("{:?}", scope.scope_type());

      setscopetop(&name, &format!("{:?}", s), &tpe);
    }

    for v in hierarchy.vars() {
      let variable = hierarchy.get(v);
      log(&format!("Item: {:?}", variable));
    }
  }

  fn readbody() {
    let global_hierarchy = _hierarchy.lock().unwrap();
    let hierarchy = global_hierarchy.as_ref().unwrap();
    let mut global_body = _body.lock().unwrap();
    let body = global_body.take().unwrap(); // Take ownership of the body
    let mut global_time_table = _time_table.lock().unwrap();
    let mut global_signal_source = _signal_source.lock().unwrap();
    
    let body_result = read_body(body, hierarchy, None);

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
    log(&format!("Event count: {:?}", event_count));
    if event_count <= 128 {
      min_timestamp = time_table[event_count - 1];
    } else {
      for i in 128..event_count {
        let rolling_time_step = time_table[i] - time_table[i - 128];
        min_timestamp = std::cmp::min(rolling_time_step, min_timestamp);
      }
    }
    log(&format!("Setting chunk size to: {:?}", min_timestamp));

    setchunksize(min_timestamp, time_end_extend);
  }

  // returns a JSON string of the children of the given path
  // Since WASM is limited to 64K memory, we need to limit the return size
  // and allow the function to be called multiple times to get all the data
  fn getchildren(path: String, startindex: u32) -> String {
    log(&format!("Getting scopes for path: {:?}", path));

    let global_hierarchy = _hierarchy.lock().unwrap();
    let hierarchy = global_hierarchy.as_ref().unwrap();

    // break up path by the "." delimiter
    let path_items: Vec<&str> = path.split('.').collect();
    let parent  = hierarchy.lookup_scope(&path_items);
    let parent_scope;

    match parent {
      Some(parent_ref) => {parent_scope = hierarchy.get(parent_ref);},
      None => {log(&format!("No scopes found")); return "{\"scopes\": [], \"vars\": []}".to_string();}
    }

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
      let id = format!("{:?}", s);
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
      let id = format!("{:?}", v);
      let tpe = format!("{:?}", var.var_type());
      let width = var.length().unwrap_or(0);
      let signal_ref = var.signal_ref().index();
      let var_string = format!("{{\"name\": {:?},\"netlistId\": {:?},\"signalId\": {:?},\"type\": {:?},\"width\": {:?}}}", name, id, signal_ref, tpe, width);
      
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
    log(&format!("Getting signal data for signal: {:?}", signalid));
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

    log(&format!("Loaded Signal! "));

    let transitions = signal.iter_changes();
    let time_index = signal.time_indices();

    log(&format!("Total Time Indices: {:?}", time_index.len()));
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

    log(&format!("Signal Data Orgainzed!"));

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


}


// Export the Filecontext to the extension code.
export!(Filecontext);