/* eslint-disable promise/prefer-await-to-callbacks */

import { spawn } from 'child_process';
import events from 'events';
import through from 'through';
const { EventEmitter } = events;
import B from 'bluebird';


class SubProcess extends EventEmitter {
  constructor (cmd, args = [], opts = {}) {
    super();
    if (!cmd) throw new Error("Command is required"); // eslint-disable-line curly
    if (typeof cmd !== "string") throw new Error("Command must be a string"); // eslint-disable-line curly
    if (!(args instanceof Array)) throw new Error("Args must be an array"); // eslint-disable-line curly
    this.cmd = cmd;
    this.args = args;
    this.proc = null;
    this.opts = opts;
    this.expectingExit = false;
  }

  get isRunning () {
    // presence of `proc` means we have connected and started
    return !!this.proc;
  }

  emitLines (stream, lines) {
    for (let line of lines) {
      this.emit('stream-line', `[${stream.toUpperCase()}] ${line}`);
    }
  }

  // spawn the subprocess and return control whenever we deem that it has fully
  // "started"
  async start (startDetector = null, timeoutMs = null) {
    let startDelay = 10;

    // the default start detector simply returns true when we get any output
    if (startDetector === null) {
      startDetector = (stdout, stderr) => {
        return stdout || stderr;
      };
    }

    // if the user passes a number, then we simply delay a certain amount of
    // time before returning control, rather than waiting for a condition
    if (typeof startDetector === 'number') {
      startDelay = startDetector;
      startDetector = null;
    }

    // return a promise so we can wrap the async behavior
    return new B((resolve, reject) => {
      // actually spawn the subproc
      this.proc = spawn(this.cmd, this.args, this.opts);

      if (this.proc.stdout) {
        this.proc.stdout.setEncoding(this.opts.encoding || 'utf8');
      }
      if (this.proc.stderr) {
        this.proc.stderr.setEncoding(this.opts.encoding || 'utf8');
      }
      this.lastLinePortion = {stdout: '', stderr: ''};

      // this function handles output that we collect from the subproc
      const handleOutput = (data) => {
        // if we have a startDetector, run it on the output so we can resolve/
        // reject and move on from start
        try {
          if (startDetector && startDetector(data.stdout, data.stderr)) {
            startDetector = null;
            resolve();
          }
        } catch (e) {
          reject(e);
        }

        // emit the actual output for whomever's listening
        this.emit('output', data.stdout, data.stderr);

        // we also want to emit lines, but it's more complex since output
        // comes in chunks and a line could come in two different chunks, so
        // we have logic to handle that case (using this.lastLinePortion to
        // remember a line that started but did not finish in the last chunk)
        for (let stream of ['stdout', 'stderr']) {
          if (!data[stream]) continue; // eslint-disable-line curly
          let lines = data[stream].split("\n");
          if (lines.length > 1) {
            let retLines = lines.slice(0, -1);
            retLines[0] = this.lastLinePortion[stream] + retLines[0];
            this.lastLinePortion[stream] = lines[lines.length - 1];
            this.emit(`lines-${stream}`, retLines);
            this.emitLines(stream, retLines);
          } else {
            this.lastLinePortion[stream] += lines[0];
          }
        }
      };

      // if we get an error spawning the proc, reject and clean up the proc
      this.proc.on('error', err => {
        this.proc.removeAllListeners('exit');
        this.proc.kill('SIGINT');

        if (err.errno === 'ENOENT') {
          err = new Error(`Command '${this.cmd}' not found. Is it installed?`);
        }
        reject(err);
      });

      if (this.proc.stdout) {
        this.proc.stdout.pipe(through(stdout => {
          handleOutput({stdout, stderr: ''});
        }));
      }

      if (this.proc.stderr) {
        this.proc.stderr.pipe(through(stderr => {
          handleOutput({stdout: '', stderr});
        }));
      }

      // when the proc exits, we might still have a buffer of lines we were
      // waiting on more chunks to complete. Go ahead and emit those, then
      // re-emit the exit so a listener can handle the possibly-unexpected exit
      this.proc.on('exit', (code, signal) => {
        this.handleLastLines();

        this.emit('exit', code, signal);

        // in addition to the bare exit event, also emit one of three other
        // events that contain more helpful information:
        // 'stop': we stopped this
        // 'die': the process ended out of our control with a non-zero exit
        // 'end': the process ended out of our control with a zero exit
        let event = this.expectingExit ? 'stop' : 'die';
        if (!this.expectingExit && code === 0) {
          event = 'end';
        }
        this.emit(event, code, signal);

        // finally clean up the proc and make sure to reset our exit
        // expectations
        this.proc = null;
        this.expectingExit = false;
      });

      // if the user hasn't given us a startDetector, instead just resolve
      // when startDelay ms have passed
      if (!startDetector) {
        setTimeout(() => { resolve(); }, startDelay);
      }

      // if the user has given us a timeout, start the clock for rejecting
      // the promise if we take too long to start
      if (typeof timeoutMs === "number") {
        setTimeout(() => {
          reject(new Error("The process did not start in the allotted time " +
            `(${timeoutMs}ms)`));
        }, timeoutMs);
      }
    });
  }

  handleLastLines () {
    for (let stream of ['stdout', 'stderr']) {
      if (this.lastLinePortion[stream]) {
        const lastLines = [this.lastLinePortion[stream]];
        this.emit(`lines-${stream}`, lastLines);
        this.emitLines(stream, lastLines);
        this.lastLinePortion[stream] = '';
      }
    }
  }

  async stop (signal = 'SIGTERM', timeout = 10000) {
    if (!this.isRunning) {
      throw new Error(`Can't stop process; it's not currently running (cmd: '${this.cmd}')`);
    }
    // make sure to emit any data in our lines buffer whenever we're done with
    // the proc
    this.handleLastLines();
    return new B((resolve, reject) => {
      this.proc.on('close', resolve);
      this.expectingExit = true;
      this.proc.kill(signal);
      setTimeout(() => {
        reject(new Error(`Process didn't end after ${timeout}ms`));
      }, timeout);
    });
  }

  async join (allowedExitCodes = [0]) {
    if (!this.isRunning) {
      throw new Error("Can't join process; it's not currently running");
    }

    return new B((resolve, reject) => {
      this.proc.on('exit', (code) => {
        if (allowedExitCodes.indexOf(code) === -1) {
          reject(new Error(`Process ended with exitcode ${code}`));
        } else {
          resolve(code);
        }
      });
    });
  }
}

export { SubProcess };
export default SubProcess;
