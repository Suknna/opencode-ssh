import { SSHManagerError } from "./types.js";

export function decodeControlSequences(input: string): string {
  let output = "";

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char !== "\\") {
      output += char;
      continue;
    }

    const sequenceType = input[index + 1];
    if (sequenceType === undefined) {
      output += char;
      continue;
    }

    if (sequenceType === "n") {
      output += "\n";
      index += 1;
      continue;
    }
    if (sequenceType === "r") {
      output += "\r";
      index += 1;
      continue;
    }
    if (sequenceType === "t") {
      output += "\t";
      index += 1;
      continue;
    }
    if (sequenceType === "x") {
      const hex = input.slice(index + 2, index + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw controlSequenceError("Invalid \\xNN control sequence.");
      }
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 3;
      continue;
    }
    if (sequenceType === "u") {
      const hex = input.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw controlSequenceError("Invalid \\uNNNN control sequence.");
      }
      output += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
      continue;
    }

    output += char;
  }

  return output;
}

function controlSequenceError(message: string): SSHManagerError {
  return new SSHManagerError("CONFIG_INVALID", message);
}
