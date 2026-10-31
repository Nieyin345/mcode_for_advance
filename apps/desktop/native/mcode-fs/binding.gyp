{
  "targets": [
    {
      "target_name": "mcode_fs",
      "sources": [
        "src/addon.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NAPI_CPP_EXCEPTIONS"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": [ "/std:c++20" ]
        }
      },
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": [ "src/fs_win32.cc" ],
            "defines": [ "WIN32_LEAN_AND_MEAN", "NOMINMAX", "_WIN32_WINNT=0x0A00" ]
          }
        ],
        [
          "OS=='mac'",
          {
            "sources": [ "src/fs_posix.cc" ],
            "defines": [ "_DARWIN_C_SOURCE" ],
            "cflags_cc!": [ "-fno-exceptions" ],
            "cflags_cc": [ "-std=c++17", "-fexceptions" ],
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
            }
          }
        ],
        [
          "OS=='linux'",
          {
            "sources": [ "src/fs_posix.cc" ],
            "defines": [ "_GNU_SOURCE" ],
            "cflags_cc!": [ "-fno-exceptions" ],
            "cflags_cc": [ "-std=c++17", "-fexceptions" ]
          }
        ]
      ]
    }
  ]
}
