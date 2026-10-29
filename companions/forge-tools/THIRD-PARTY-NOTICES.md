# Third-party notices

DSH Forge implementation is original. API and behavioral compatibility were
researched from the sources listed in docs/RESEARCH.md. Community implementations
were studied, not vendored.

## DeepSeek Harness preset composition

The two delivered preset lists adapt the standard preset shipped in
DeepSeek Harness 0.2.1-rc.3, upstream commit
1f81c047fc48fa190a683e469daa699857e9afe8.
Source: https://github.com/deepseek-ai/deepseek-harness

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ripgrep Windows x64

Binary distributed by Microsoft as @vscode/ripgrep-win32-x64 1.18.0.
Actual binary reports ripgrep 15.0.0, PCRE2 10.45.
Microsoft prebuilt release: https://github.com/microsoft/ripgrep-prebuilt/releases/tag/v15.0.1
Upstream: https://github.com/BurntSushi/ripgrep
Package MIT notice is included at bin/RIPGREP-LICENSE.txt.
ripgrep's upstream MIT and Unlicense texts and PCRE2 notice are included
in bin/UPSTREAM-LICENSES.txt.

## Host peer dependencies

@deepseek-ai/cordis 4.0.5, @deepseek-ai/schemastery 3.18.5,
@deepseek-ai/dsh-tools, dsh-fs, dsh-llm, and dsh-sandbox 0.2.1-rc.3 are external
host services and are not redistributed inside this package.
