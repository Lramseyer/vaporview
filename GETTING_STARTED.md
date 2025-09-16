# Getting started

This is a draft

## Language tools

To get started working on Vaporview, you will need the following installed and up to date:

- [VScode - latest](https://code.visualstudio.com/)
- [Node - 20.18.0 or later](https://nodejs.org/en)
- [Rust - 1.80.0 or later](https://www.rust-lang.org/)

## Install libraries

Once those are installed, make sure you install the necessary packages:

- `npm install`
- `cargo update`
- `cargo install wasm-tools`

## building and running

To build and run, you should be able to use the **Run and Debug** utility in VScode. It will do the following steps automatically, but in case you need to do them individually (which does happen)

### Compile WebAssembly component

This compiles Rust code to a WASM binary

`cargo build --target wasm32-unknown-unknown --release`

Note that there are 2 types of WASM compile options: "debug" and "release". The debug version is much slower, and largely unused. This is good for general debug of functionality, but is not recommended for testing large files.

### Generate WebAssembly interface

This generates filehandler.ts. I opted to not check in this file since it's technically considered compiled/generated code. In the VScode extension examples, these files are checked in, and I spent an annoying amount of time trying to understand how it worked until I realized that I didn't need to understand it. In fact, the whole point of the .wit file and wit2ts tool is that we don't need to understand this file.

`npm run generate:model`

### "Compile" Typescript

This "compiles" Typescript into Javascript.

`tsc -b`

## (Optional) Build FSDB addon

To read FSDB, you will need to compile FSDB addon node module

### Specify FSDB reader path

Modify `binding.pyg` to your path:

```
{
  "variables": {
    "FSDB_READER_LIBS_PATH": "/home/heyfey/verdi/2022.06/share/FsdbReader/linux64", # path to find libnffr.so, libnsys.so
    "FSDB_HEADER_PATH": "/home/heyfey/verdi/2022.06/share/FsdbReader" # path to find ffrAPI.h, fsdbShr.h
  },
  ...
}
```

For Verdi users, FSDB reader path: (please find the `.so` for your platform)
```
# for .so
$VERDI_HOME/share/FsdbReader/linux64/

# for .h
$VERDI_HOME/share/FsdbReader/
```

For Xcelium (xrun) users, FSDB reader might be found in:
```
# for .so
$XCELIUM_HOME/tools.lnx86/lib/64bit/

# for .h
$XCELIUM_HOME/include/fsdb/
```

### Compile FSDB addon

This compile the node module to read FSDB

`npm run compile-addon`

The node module will be in `./build/Release/`, you can simply move them to the installed extension path:

```
# Move the node modules to installed extension
cp -r ./build/ ~/.vscode/extensions/lramseyer.vaporview-<xx.yy.zz>/

# Or if you're in remote-ssh
cp -r ./build/ ~/.vscode-server/extensions/lramseyer.vaporview-<xx.yy.zz>/
```

Or package to `.vsix`
```
npm run package-fsdb
vsce package
```

### Read FSDB

In setting, speficy `"vaporview.fsdbReaderLibsPath"` to find the FSDB reader

e.g.
```
"vaporview.fsdbReaderLibsPath": "/home/heyfey/verdi/2022.06/share/FsdbReader/linux64",
```