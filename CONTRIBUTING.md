# How to contribute

While this project doesn't have a large list of contributors (yet) I am more than happy to take on new contributors. For a tutorial on how to get started building Vaporview, eee [GETTING_STARTED.md](https://github.com/Lramseyer/vaporview/blob/main/GETTING_STARTED.md) for details on how to build and debug.

## Contributing bug reports and your opinions

Design opinions and bug reports are welcome. This project has thousands of users, and if you point out a bug, chances are that you're not the first one.

- [Bugs and Issues](https://github.com/Lramseyer/vaporview/issues)
- [Design Opinions](https://github.com/Lramseyer/vaporview/discussions)

Note that Vaporview uses an output log for extra debug information, which may provide relevant information to your issue.

## Contributing your code

- **No AI slop!** Feel free to use AI to assist your coding, but I still own this code base and I know how it's architected, so I will need to maintain it moving forward. If you check in a massive PR with a dozen different file edits, you better be ready to explain how it works.
- Consider small commits to establish a reputation before tackling big things.
- For larger things, communicate before throwing a massive PR over the wall. Even if it's hand written! Corporate software is planned, architected, and documented, and there's no reason why we can't do the same in the open source world.
- Consider joining the Vaporview [matrix element chat](https://matrix.to/#/#vaporview:fossi-chat.org) (It's kind of like discord)

Lloyd Ramseyer
- Github: [@lramseyer](https://github.com/Lramseyer)
- Email: laramseyer@gmail.com
- LinkedIn - [https://www.linkedin.com/in/lramseyer/](https://www.linkedin.com/in/lramseyer/)

# Basic code layout

The Vaporview codebase has 2 main components to it: The core extension in `src/extension_core` and the webview in `src/webview`. however, there are other assets like icons, and HTML/CSS files that are used in the `media` folder. This extension uses a [Custom Editor](https://code.visualstudio.com/api/references/vscode-api#CustomDocument), which is a webpage in a iframe under the hood and a messaging interface to send data back and forth. For the VCD, FST, and GHW parsing, Vaporview uses the wellen library compiled from Rust to webassembly.

## Design philosophy

Since Vaporview requires a lot of custom UI elements that do not come standard with VScode, I keep the following priorities in mind:

1. It needs to work
2. It needs to look nice
3. It needs to feel smooth and snappy wherever possible
4. It needs to follow suit with the VScode design language and behavior where posible
5. It needs to look and feel familiar to both VScode and other waveform viewers (like Surfer, GTKwave, or Verdi)

I believe good software makes the easy things easy, and the hard things possible.

## Interfacing with other extensions

Vaporview is designed to do one thing and do it well. It is intentionally language agnostic and simulator agnostic. However, it does have an API that allows other extensions to interface with Vaporview. See [API_DOCS.md](https://github.com/Lramseyer/vaporview/blob/main/API_DOCS.md) for details. If you need help integrating an extension with the Vaporview API, please reach out to me!