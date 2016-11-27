'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import * as path from 'path';
import * as fs from 'fs';

import * as Lazy from 'lazy.js';

import * as cmt from './cmt-api';

async function writeFile(filename: string, content: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    fs.writeFile(filename, content, err => {
      if (err)
        reject(err);
      else
        resolve();
    })
  });
}

type Maybe<T> = T|null;

// Colors from http://colorbrewer2.org/#type=qualitative&scheme=Pastel1&n=8
const COLORS = ['#fbb4ae','#b3cde3','#ccebc5','#decbe4','#fed9a6','#ffffcc','#e5d8bd','#fddaec'];

interface AssemblyListing {
  line: number;
  file: string;
  assembly: string;
  code: string;
  color: string;
}

class AssemblyExplorer implements vscode.TextDocumentContentProvider {
  private _emitter = new vscode.EventEmitter<vscode.Uri>();
  private _statusMessageItem =
      vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
  private _cmakeTools: Promise<Maybe<cmt.CMakeToolsAPI>> = (async() => {
    const ext =
        vscode.extensions.all.find(e => e.id == 'vector-of-bool.cmake-tools');
    if (ext) {
      if (!ext.isActive) await ext.activate();
      const cmt = await ext.exports as cmt.CMakeToolsAPI;
      await(cmt as any).configure();
      return cmt;
    }
    vscode.window.showWarningMessage(
        'Assembly Explorer currently requires CMake Tools extension to be installed');
  })();
  private _activeEditor: Maybe<vscode.TextEditor>;
  private _debouncers: Map<string, NodeJS.Timer> = new Map();
  private _debouncer: NodeJS.Timer = setTimeout(() => {}, 0);
  private _listing: Maybe<AssemblyListing[]>;

  private static _uri = vscode.Uri.parse('asme://viewer');
  public static get uri(): vscode.Uri {
    return AssemblyExplorer._uri;
  }

  constructor(private _context: vscode.ExtensionContext) {
    this._statusMessageItem.show();
    this.statusMessage = 'Inactive';
    const editor = vscode.window.activeTextEditor;
    vscode.workspace.onDidChangeTextDocument(this._documentChanged, this);
    vscode.window.onDidChangeActiveTextEditor(this._setActiveEditor, this);
  }

  async provideTextDocumentContent(uri: vscode.Uri, cancellation: vscode.CancellationToken): Promise<string> {
    if (!this._listing) {
      return 'No assembly listing for current source file';
    }
    const ret = `
      <html>
        <head>
          <base href="${this._context.extensionPath}/">
          <!--<link rel="import" href="elements.html">-->
          <link rel="stylesheet" href="bower_components/codemirror/lib/codemirror.css">
          <script src="bower_components/codemirror/lib/codemirror.js"></script>
          <script>
            CodeMirror.defineMode("asm", function () {
                function tokenString(quote) {
                    return function (stream) {
                        var escaped = false, next, end = false;
                        while ((next = stream.next()) !== null) {
                            if (next == quote && !escaped) {
                                end = true;
                                break;
                            }
                            escaped = !escaped && next == "\\\\";
                        }
                        return "string";
                    };
                }

                var x86_32regName = /\\b[re]?(ax|bx|cx|dx|si|di|bp|ip|sp)\\b/;
                var x86_64regName = /r[\\d]+[d]?/;
                var x86_xregName = /[xy]mm\\d+/;
                var x86_keywords = /PTR|BYTE|[DQ]?WORD|XMMWORD|YMMWORD/;
                var labelName = /\\.L\\w+/;

                return {
                    token: function (stream) {
                        if (stream.match(/\\/\\*([^*]|[*][^\\/])*\\**\\//)) {
                            return "comment";
                        }
                        if (stream.match(/^.+:$/)) {
                            return "variable-2";
                        }
                        if (stream.sol() && stream.match(/^\\s*\\.\\w+/)) {
                            return "header";
                        }
                        if (stream.sol() && stream.match(/^\\s+\\w+/)) {
                            return "keyword";
                        }
                        if (stream.eatSpace()) return null;
                        if (stream.match(x86_32regName) || stream.match(x86_64regName) || stream.match(x86_xregName)) {
                            return "variable-3";
                        }
                        if (stream.match(x86_keywords)) return "keyword";
                        if (stream.match(labelName)) return "variable-2";
                        var ch = stream.next();
                        if (ch == '"' || ch == "'") {
                            return tokenString(ch)(stream);
                        }
                        if (/[\\[\\]{}\\(\\),;\\:]/.test(ch)) return null;
                        if (/[\\d$]/.test(ch) || (ch == '-' && stream.peek().match(/[0-9]/))) {
                            stream.eatWhile(/[\\w\\.]/);
                            return "number";
                        }
                        if (ch == '%') {
                            stream.eatWhile(/\\w+/);
                            return "variable-3";
                        }
                        if (ch == '#') {
                            stream.eatWhile(/.*/);
                            return "comment";
                        }
                        stream.eatWhile(/[^\s]*/);
                        return "word";
                    }
                };
            });

            CodeMirror.defineMIME("text/x-asm", "asm");
          </script>
          <style>
            html, body {
              margin: 0;
              width: 100%;
              height: 100%;
              padding: 0;
            }
            #area, .CodeMirror {
              font-size: 12pt;
              width: 100%;
              height: 100%;
            }
            .asme-codeline {
              font-style: italic;
              color: gray;
            }
          </style>
        </head>
        <body>
          <textarea id=area></textarea>
          <script>
            (() => {
              const asm = ${JSON.stringify(this._listing)};
              const cm = CodeMirror.fromTextArea(document.getElementById('area'), {
                lineNumbers: true,
                mode: 'text/x-asm',
                readOnly: true,
                gutters: ['CodeMirror-linenumbers'],
                // lineWrapping: true,
              });
              const colors = ${JSON.stringify(COLORS)};
              const style = document.createElement('style');
              let counter = 0;
              const classes = colors.map(
                col => '.bgc-' + counter++ + ' { background: ' + col + '; }'
              ).join('\\n');
              style.appendChild(document.createTextNode(classes));
              document.head.appendChild(style);
              cm.operation(() => {
                cm.setValue(
                  asm.reduce(
                    (acc, entry) => acc + ';== ' + entry.code + '\\n' + entry.assembly + '\\n',
                    ''
                  )
                );
                let curline = 0;
                for (const item of asm) {
                  let nlines = item.assembly.split('\\n').length;
                  cm.addLineClass(curline++, 'asme-codeline', 'asme-codeline');
                  while (nlines--) {
                    const cls = 'bgc-' + (item.line * 11 % colors.length);
                    cm.addLineClass(curline++, 'bg-color', cls);
                  }
                }
              });
            })();
          </script>
        </body>
      </html>
    `;
    this._context.extensionPath;
    console.log('Providing a new document!');
    return ret;
  }

  get onDidChange(): vscode.Event<vscode.Uri> {
    return this._emitter.event;
  }

  public update(uri: vscode.Uri) {
    this._debounce
  }

  private _debounce<T>(id: string, action: () => T): Promise<T> {
    const timer = this._debouncers.get(id);
    if (timer) {
      clearTimeout(timer);
    }
    return new Promise<T>((resolve, reject) => {
      const new_timer = setTimeout(() => {
        try {
          resolve(action());
        } catch (e) {
          reject(e);
        }
      }, 1000);
      this._debouncers.set(id, new_timer);
    })
  }

  private _statusMessage: string;
  public get statusMessage(): string {
    return this._statusMessage;
  }
  public set statusMessage(v: string) {
    this._statusMessage = v;
    this._statusMessageItem.text = `Assembly Explorer: ${v}`;
  }

  private _setActiveEditor(editor: Maybe<vscode.TextEditor>) {
    this._activeEditor = editor;
  }

  private async _decorateMSVC(
      info: cmt.CompilationInfo, doc: vscode.TextDocument, command: string[],
      editor: vscode.TextEditor): Promise<AssemblyListing[]|null> {
    console.log('Decorating with MSVC');
    const cmt = (await this._cmakeTools)!;
    console.assert(cmt);
    console.assert(command.length > 1);
    const prog = command[0];
    const args = command.slice(1);
    // Tweak the compile command to generate an assemly listing instead of a
    // regular object file.
    for (const remove_prefix of ['Fo', 'Fd', 'Fm', 'Fa', 'Fp', 'Fe', 'Fr', 'Fi']) {
      const idx = args.findIndex(item => item.startsWith('-' + remove_prefix) || item.startsWith('/' + remove_prefix));
      if (idx < 0)
        continue;
      if (args[idx].length == remove_prefix.length + 1) {
        args.splice(idx, 2);
      } else {
        args.splice(idx, 1);
      }
    }
    for (const remove of ['Zi', 'Z7']) {
      const idx = args.findIndex(item => item.startsWith('-' + remove) || item.startsWith('/' + remove));
      if (idx >= 0)
        args.splice(idx, 1);
    }
    const src_name = path.basename(doc.fileName);
    const asmpath = path.join(cmt.binaryDir, src_name.replace(path.extname(src_name), '.asme.asm'));
    const tmppath = path.join(path.dirname(doc.fileName), '.asme-' + src_name);
    await writeFile(tmppath, doc.getText());
    const out_idx = args.findIndex(item => !!item.match(/^[/-]c/));
    if (out_idx >= 0) {
      const out_arg = args[out_idx];
      if (out_arg.length == 2) {
        args.splice(out_idx, 2);
      } else {
        args.splice(out_idx, 1);
      }
    }
    args.push('-c', tmppath);
    args.splice(0, 0, '/Fo' + asmpath + '.obj');
    args.splice(0, 0, '/FAs', '/Fa' + asmpath);
    const cd = process.cwd();
    const result = await (async () => {
      try {
        process.chdir(info.directory);
        return await cmt.execute(prog, args, {silent: true, environment: {}});
      } finally {
        process.chdir(cd);
      }
    })();
    fs.unlink(tmppath);
    if (result.retc !== 0) {
      this.statusMessage = 'Compile error';
      return null;
    }
    const state = {
      in_file: false,
      in_text: false,
      current_line: 0,
      line_content: new Map<number, string[]>()
    };
    const line_re = /^;\s+(\d+)\s+:/;
    // line_re.compile();
    const filestream: any = Lazy.readFile(asmpath);
    const seq = filestream
      .lines()
      .each((line: string) => {
        if (line.startsWith('; File ')) {
          if (line.trim() == `; File ${tmppath}`) {
            state.in_file = true;
          } else {
            state.in_file = false;
            state.in_text = false;
            state.current_line = 0;
          }
          return;
        }
        if (!state.in_file)
          return;
        if (line.startsWith('_TEXT') && line.endsWith('SEGMENT')) {
          state.in_text = true;
          return;
        }
        if (line.endsWith('ENDP') || (line.startsWith('_TEXT') && line.endsWith('ENDS'))) {
          state.in_file = false;
          state.in_text = false;
          state.current_line = 0;
          return;
        }
        if (line.startsWith(';')) {
          const mat = line_re.exec(line);
          if (mat) {
            const line = parseInt(mat[1]);
            if (line > doc.lineCount || state.line_content.has(line)) {
              // Skip lines which have already appeared or do not appear in the
              // current file. They are extra bits generated by MSVC. Not sure
              // how we want to display those
              state.current_line = 0;
            } else {
              state.current_line = line;
            }
            return;
          }
          return;
        }
        const tr = line.trim();
        if (tr === '') {
          return;
        }
        if (!line.startsWith('\t')) {
          // All assembly instructions lead with a tabstop
          state.current_line = 0;
          return;
        }
        if (state.current_line != 0) {
          const asm_lines = state.line_content.get(state.current_line);
          if (!asm_lines) {
            state.line_content.set(state.current_line, [line]);
          } else {
            asm_lines.push(line);
          }
        }
      });
    const pr = new Promise((resolve, reject) => {
      seq.onError((e) => {
        debugger;
        reject(e);
      });
      seq.onComplete(resolve);
    });
    await pr;
    return Array.from(state.line_content.entries())
      .map(([lineno, asms]): AssemblyListing => {
        return {
          file: doc.fileName,
          line: lineno,
          assembly: asms.join('\r\n'),
          code: doc.lineAt(Math.min(lineno, doc.lineCount) - 1).text,
          color: COLORS[lineno * 11 % COLORS.length],
        };
      })
      .sort((a, b) => a.line - b.line);
  }

  private async _decorateGCC(
      info: cmt.CompilationInfo, doc: vscode.TextDocument, command: string[],
      editor: vscode.TextEditor): Promise<AssemblyListing[]> {
    console.log('Decorating with GCC/Clang');
    return [];
  }

  private async _documentChanged(event: vscode.TextDocumentChangeEvent) {
    const filepath = event.document.fileName;
    // Check that we care about the document language
    if (['c', 'cpp'].indexOf(event.document.languageId) < 0) {
      // This docucment doesn't have a language we care about.
      return;
    }
    // We want the editor that corresponds with that doc.
    const editor = vscode.window.visibleTextEditors.find(
        ed => ed.document.fileName == event.document.fileName);
    if (!editor) {
      // Changed doc is not in an open edior. We don't care about this
      // change event.
      return;
    }
    const cmt = await this._cmakeTools;
    if (!cmt) {
      return;
    }
    const info = await cmt.compilationInfoForFile(filepath);
    if (!info) {
      return;
    }
    const cmd_re = /('(\\'|[^'])*'|"(\\"|[^"])*"|(\\ |[^ ])+|[\w-]+)/g;
    const quoted_args = info.command.match(cmd_re);
    console.assert(quoted_args);
    // Our regex will parse escaped quotes, but they remain. We must
    // remove them ourselves
    const command = quoted_args!.map(arg => arg.replace(/\\(")/g, '$1'))
                        const compiler = command[0];
    this.statusMessage = 'Recompiling...';
    const regen_id = 'regenerate';
    const pr: Promise<AssemblyListing[]|null> = (() => {
      if (compiler.endsWith('cl.exe')) {
        return this._debounce(
            regen_id, () => this._decorateMSVC(info, event.document, command, editor));
      } else if (/(gcc|clang)(.exe)?$/, test(compiler)) {
        return this._debounce(
            regen_id, () => this._decorateGCC(info, event.document, command, editor));
      } else {
        this.statusMessage = `Unknown compiler: ${compiler}`;
        return Promise.resolve();
      }
    })();
    const pad = (str: string, pad: string, count: number): string => {
      return Array(Math.max(0, count - str.length)).join(pad) + str;
    };
    pr.then(listing => {
      if (listing) {
        this._listing = listing;
        const doc = editor.document;
        this._emitter.fire(AssemblyExplorer.uri);
        editor.setDecorations(this._decorType,
          listing.map((asm): vscode.DecorationOptions => {
            const nlines = asm.assembly.split('\n').length;
            return {
              hoverMessage: {
                value: asm.assembly,
                language: 'asm',
              },
              renderOptions: {
                after: {
                  backgroundColor: asm.color,
                }
              },
              range: doc.lineAt(Math.min(asm.line, doc.lineCount) - 1).range
            }
          }));
      }
    }).catch(e => {
      debugger;
      console.error(e);
    })
  }

  private _decorType = vscode.window.createTextEditorDecorationType({
    after: {
      width: '1.1em',
      height: '1.1em',
      margin: '0 0.2em 0 0.2em',
      border: '0.1em solid gray',
      contentText: ' ',
    },
  });
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors
  // (console.error)
  // This line of code will only be executed once when your extension is
  // activated
  console.log('Congratulations, your extension "asm-explorer" is now active!');

  const provider = new AssemblyExplorer(context);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('asme', provider),
    vscode.commands.registerCommand('asme.showExplorerToSide', (uri?: vscode.Uri) => {
      if (!uri) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }
        uri = editor.document.uri;
      }
      // provider.enable();
      const column = (() => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
          return vscode.ViewColumn.Two;
        return vscode.ViewColumn.Three;
      })();
      return vscode.commands.executeCommand('vscode.previewHtml',
        AssemblyExplorer.uri,
        column,
        'Assembly Explorer'
      );
    }),
  );
}

// this method is called when your extension is deactivated
export function deactivate() {}