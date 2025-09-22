{
  "variables": {
    "FSDB_READER_LIBS_PATH": "/home/heyfey/verdi/2022.06/share/FsdbReader/linux64", # path to find libnffr.so, libnsys.so
    "FSDB_HEADER_PATH": "/home/heyfey/verdi/2022.06/share/FsdbReader" # path to find ffrAPI.h, fsdbShr.h
  },
  "targets": [
    {
      "target_name": "fsdb_reader",
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "sources": [ "src/fsdb_reader.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(FSDB_HEADER_PATH)"
      ],
      'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS' ],
      "ldflags": [
        "-L<(FSDB_READER_LIBS_PATH)",
        "-static-libstdc++" # to solve GLIBCXX not found
      ],
      "libraries": [
        # "<(FSDB_READER_LIBS_PATH)/libnffr.so",
        # "<(FSDB_READER_LIBS_PATH)/libnsys.so",
        "-lnffr",
        "-lnsys"
      ],
    }
  ]
}