// Use a procedural macro to generate bindings for the world we specified in
// `host.wit`

wit_bindgen::generate!({
	// the name of the world in the `*.wit` input file
	world: "filehandler",
});

use std::io::{self, Read, Seek, SeekFrom};
use lazy_static::lazy_static;
use std::sync::Mutex;

lazy_static! {
	static ref WASM_FILE_READER: Mutex<Option<WasmFileReader>> = Mutex::new(None);
	static ref DUMMY_ITERATOR: Mutex<Option<i32>> = Mutex::new(None);
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

	//fn calc(op: Operation) -> u32 {
	//	log(&format!("Starting calculation: {:?}", op));
	//	let result = match op {
	//		Operation::Add(operands) => operands.left + operands.right,
	//		Operation::Sub(operands) => operands.left - operands.right,
	//		Operation::Mul(operands) => operands.left * operands.right,
	//		Operation::Div(operands) => operands.left / operands.right,
	//	};
	//	log(&format!("Finished calculation: {:?}", op));
	//	result 
	//}

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

}

// Export the Filecontext to the extension code.
export!(Filecontext);