// Use a procedural macro to generate bindings for the world we specified in
// `host.wit`

wit_bindgen::generate!({
	// the name of the world in the `*.wit` input file
	world: "filehandler",
});

use std::io::{self, Read, Seek, SeekFrom};
use std::num::NonZeroI32;
use std::num::NonZeroU32;
use lazy_static::lazy_static;
use std::sync::Mutex;
use wellen::{simple, GetItem, Hierarchy, HierarchyItem, ScopeRef, ScopeType, VarRef};
use wellen::viewers::{HeaderResult, read_header_from_bytes, read_body};
use wellen::LoadOptions;


lazy_static! {
	static ref WASM_FILE_READER: Mutex<Option<WasmFileReader>> = Mutex::new(None);
	static ref DUMMY_ITERATOR: Mutex<Option<i32>> = Mutex::new(None);
	static ref file_contents: Mutex<Option<HeaderResult>> = Mutex::new(None);
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
			SeekFrom::Start(offset) => {
				self.offset = offset;
			}
			SeekFrom::End(offset) => {
				self.offset = (self.size as i64 + offset) as u64;
			}
			SeekFrom::Current(offset) => {
				self.offset = (self.offset as i64 + offset) as u64;
			}
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
		let mut contents = file_contents.lock().unwrap();

		// Use wellen to read the FST file
		let result = read_header_from_bytes(file, &options);

		match result {
			Ok(header) => {
				*contents = Some(header);
				log(&format!("Successfully loaded FST"));
			},
			Err(e) => {log(&format!("Error loading FST: {:?}", e)); return;}
		}

		let hierarchy = &contents.as_ref().unwrap().hierarchy;

		for s in hierarchy.scopes() {
			let scope = hierarchy.get(s);
			log(&format!("ID: {:?} Scope: {:?}", s, scope));
			let name = scope.name(&hierarchy).to_string();
			let tpe = map_scope_type(scope.scope_type());

			setscopetop(&name, &format!("{:?}", s), tpe);
		}

		for v in hierarchy.vars() {
			let variable = hierarchy.get(v);
			log(&format!("Item: {:?}", variable));
		}
	}

//	fn readbody() {
//		let binding = file_contents.lock().unwrap();
//		let hierarchy = &binding.as_ref().unwrap().hierarchy;
//		let body = &binding.as_ref().unwrap().body;
//		
//		let body_result = read_body(body, hierarchy, None);
//
//		
//	}


	// returns a JSON string of the children of the given path
	fn getchildren(path: String) -> String {
		log(&format!("Getting scopes for path: {:?}", path));

		let binding = file_contents.lock().unwrap();
    let hierarchy = &binding.as_ref().unwrap().hierarchy;

		// break up path by the "." delimiter
		let path_items: Vec<&str> = path.split('.').collect();
		let parent  = hierarchy.lookup_scope(&path_items);
		let parent_scope;

		match parent {
			Some(parent_ref) => {parent_scope = hierarchy.get(parent_ref);},
			None => {log(&format!("No scopes found")); return "{\"scopes\": [], \"vars\": []}".to_string();}
		}

		let child_scopes = parent_scope.scopes(&hierarchy);
		let mut child_scopes_string: Vec<String> = Vec::new();
		for s in child_scopes {
			let scope = hierarchy.get(s);
			let name = scope.name(&hierarchy).to_string();
			let id = format!("{:?}", s);
			let tpe = format!("{:?}", scope.scope_type());
			let scope_string = format!("{{\"name\": {:?}, \"id\": {:?}, \"type\": {:?}}}", name, id, tpe);
			child_scopes_string.push(scope_string);
		}

		let child_vars = parent_scope.vars(&hierarchy);
		let mut child_vars_string: Vec<String> = Vec::new();
		for v in child_vars {
			let var = hierarchy.get(v);
			let name = var.name(&hierarchy).to_string();
			let id = format!("{:?}", v);
			let tpe = format!("{:?}", var.var_type());
			let width = var.length().unwrap_or(0);
			let var_string = format!("{{\"name\": {:?}, \"id\": {:?}, \"type\": {:?}, \"width\": {:?}}}", name, id, tpe, width);
			child_vars_string.push(var_string);
		}

		let mut result = String::from("{\"scopes\": [");
		result.push_str(&child_scopes_string.join(","));
		result.push_str("], \"vars\": [");
		result.push_str(&child_vars_string.join(","));
		result.push_str("]}");
		result
	}


}

fn map_scope_type(scope_type: ScopeType) -> Scopetype {
	match scope_type {
			ScopeType::Module => Scopetype::Module,
			ScopeType::Task => Scopetype::Task,
			ScopeType::Function => Scopetype::Function,
			ScopeType::Begin => Scopetype::Begin,
			ScopeType::Fork => Scopetype::Fork,
			ScopeType::Generate => Scopetype::Generate,
			ScopeType::Struct => Scopetype::Struct,
			ScopeType::Union => Scopetype::Union,
			ScopeType::Class => Scopetype::Class,
			ScopeType::Interface => Scopetype::Interfac,
			ScopeType::Package => Scopetype::Packag,
			ScopeType::Program => Scopetype::Program,
			ScopeType::VhdlArchitecture => Scopetype::Vhdlarchitecture,
			ScopeType::VhdlProcedure => Scopetype::Vhdlprocedure,
			ScopeType::VhdlFunction => Scopetype::Vhdlfunction,
			ScopeType::VhdlRecord => Scopetype::Vhdlrecord,
			ScopeType::VhdlProcess => Scopetype::Vhdlprocess,
			ScopeType::VhdlBlock => Scopetype::Vhdlblock,
			ScopeType::VhdlForGenerate => Scopetype::Vhdlforgenerate,
			ScopeType::VhdlIfGenerate => Scopetype::Vhdlifgenerate,
			ScopeType::VhdlGenerate => Scopetype::Vhdlgenerate,
			ScopeType::VhdlPackage => Scopetype::Vhdlpackage,
			ScopeType::GhwGeneric => Scopetype::Ghwgeneric,
			ScopeType::VhdlArray => Scopetype::Vhdlarray,
	}
}

// Export the Filecontext to the extension code.
export!(Filecontext);