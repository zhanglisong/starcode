import path from "node:path";

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function ensureNonEmptyPath(rawPath, kind) {
  const value = String(rawPath ?? "").trim();
  if (!value) {
    throw new Error(`Invalid ${kind} path in patch`);
  }
  return value;
}

function parseHeader(line) {
  if (line.startsWith("*** Add File: ")) {
    return {
      type: "add",
      path: ensureNonEmptyPath(line.slice("*** Add File: ".length), "add")
    };
  }

  if (line.startsWith("*** Delete File: ")) {
    return {
      type: "delete",
      path: ensureNonEmptyPath(line.slice("*** Delete File: ".length), "delete")
    };
  }

  if (line.startsWith("*** Update File: ")) {
    return {
      type: "update",
      path: ensureNonEmptyPath(line.slice("*** Update File: ".length), "update")
    };
  }

  return null;
}

function parseAddBody(lines, start, end) {
  const output = [];
  let index = start;

  while (index < end) {
    const line = lines[index];
    if (line.startsWith("*** ")) {
      break;
    }
    if (!line.startsWith("+")) {
      throw new Error("Add file lines must start with '+'");
    }
    output.push(line.slice(1));
    index += 1;
  }

  return {
    nextIndex: index,
    content: output.join("\n")
  };
}

function finalizeChunk(chunks, chunk) {
  if (!chunk) {
    return;
  }

  if (!chunk.lines.length) {
    throw new Error("Update chunk cannot be empty");
  }

  chunks.push(chunk);
}

function parseUpdateBody(lines, start, end) {
  let index = start;
  let moveTo = "";
  const chunks = [];
  let currentChunk = null;

  if (index < end && lines[index].startsWith("*** Move to: ")) {
    moveTo = ensureNonEmptyPath(lines[index].slice("*** Move to: ".length), "move");
    index += 1;
  }

  while (index < end) {
    const line = lines[index];
    if (line.startsWith("*** ")) {
      break;
    }

    if (line === "*** End of File") {
      if (!currentChunk) {
        throw new Error("*** End of File must follow an update chunk");
      }
      currentChunk.endOfFile = true;
      index += 1;
      continue;
    }

    if (line.startsWith("@@")) {
      finalizeChunk(chunks, currentChunk);
      currentChunk = {
        header: line,
        lines: [],
        endOfFile: false
      };
      index += 1;
      continue;
    }

    if (!currentChunk) {
      throw new Error("Update section must start with '@@'");
    }

    const marker = line[0];
    if (marker !== " " && marker !== "+" && marker !== "-") {
      throw new Error("Update lines must start with ' ', '+', or '-'");
    }
    currentChunk.lines.push(line);
    index += 1;
  }

  finalizeChunk(chunks, currentChunk);

  if (!chunks.length) {
    throw new Error("Update file must include at least one chunk");
  }

  return {
    nextIndex: index,
    moveTo: moveTo || null,
    chunks
  };
}

export function parseApplyPatchText(patchText) {
  const normalized = normalizeText(patchText);
  const lines = normalized.split("\n");

  const beginIndex = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const endIndex = lines.findIndex((line) => line.trim() === "*** End Patch");

  if (beginIndex < 0 || endIndex < 0 || beginIndex >= endIndex) {
    throw new Error("Invalid patch: missing *** Begin Patch or *** End Patch");
  }

  const operations = [];
  let index = beginIndex + 1;

  while (index < endIndex) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const header = parseHeader(line);
    if (!header) {
      throw new Error(`Unexpected patch line: ${line}`);
    }

    if (header.type === "add") {
      const parsed = parseAddBody(lines, index + 1, endIndex);
      operations.push({
        type: "add",
        path: header.path,
        content: parsed.content
      });
      index = parsed.nextIndex;
      continue;
    }

    if (header.type === "delete") {
      operations.push({
        type: "delete",
        path: header.path
      });
      index += 1;
      continue;
    }

    const parsedUpdate = parseUpdateBody(lines, index + 1, endIndex);
    operations.push({
      type: "update",
      path: header.path,
      move_to: parsedUpdate.moveTo,
      chunks: parsedUpdate.chunks
    });
    index = parsedUpdate.nextIndex;
  }

  if (!operations.length) {
    throw new Error("Invalid patch: no file operations found");
  }

  return {
    operations
  };
}

function stripMarker(line) {
  return String(line ?? "").slice(1);
}

function buildChunkOldLines(chunk) {
  const output = [];
  for (const line of chunk.lines) {
    const marker = line[0];
    if (marker === " " || marker === "-") {
      output.push(stripMarker(line));
    }
  }
  return output;
}

function buildChunkNewLines(chunk) {
  const output = [];
  for (const line of chunk.lines) {
    const marker = line[0];
    if (marker === " " || marker === "+") {
      output.push(stripMarker(line));
    }
  }
  return output;
}

function findSequence(lines, target, startIndex) {
  if (!target.length) {
    return startIndex;
  }

  const maxStart = lines.length - target.length;
  for (let index = startIndex; index <= maxStart; index += 1) {
    let matched = true;
    for (let offset = 0; offset < target.length; offset += 1) {
      if (lines[index + offset] !== target[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return index;
    }
  }
  return -1;
}

export function applyUpdateChunksToLines(sourceLines, chunks) {
  const output = [];
  let cursor = 0;
  let additions = 0;
  let deletions = 0;

  for (const chunk of chunks) {
    const oldLines = buildChunkOldLines(chunk);
    const newLines = buildChunkNewLines(chunk);
    let index = findSequence(sourceLines, oldLines, cursor);

    if (index < 0 && oldLines.length > 0) {
      index = findSequence(sourceLines, oldLines, 0);
    }

    if (index < 0) {
      throw new Error(`Update chunk context not found (${chunk.header})`);
    }

    output.push(...sourceLines.slice(cursor, index));
    output.push(...newLines);
    cursor = index + oldLines.length;

    for (const line of chunk.lines) {
      if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
      }
    }
  }

  output.push(...sourceLines.slice(cursor));
  return {
    lines: output,
    additions,
    deletions
  };
}

export function collectPatchPaths(patchText) {
  const parsed = parseApplyPatchText(patchText);
  const output = [];
  for (const operation of parsed.operations) {
    output.push(operation.path);
    if (operation.type === "update" && operation.move_to) {
      output.push(operation.move_to);
    }
  }
  return output;
}

export function summarizeOperationTarget(operation) {
  if (operation.type === "update" && operation.move_to) {
    return `${operation.path} -> ${operation.move_to}`;
  }
  return operation.path;
}

export function normalizeOperationPath(baseDir, rawPath) {
  const absolute = path.resolve(baseDir, rawPath);
  const base = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`;
  if (absolute !== baseDir && !absolute.startsWith(base)) {
    throw new Error(`Path is outside workspace: ${rawPath}`);
  }
  return absolute;
}
