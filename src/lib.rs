// Use a procedural macro to generate bindings for the world we specified in
// `host.wit`


wit_bindgen::generate!({
	// the name of the world in the `*.wit` input file
	world: "filehandler",
});

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