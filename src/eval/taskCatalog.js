export const evalLiteTasks = [
  {
    id: "SC-EVAL-001",
    category: "coding",
    title: "Create a new file",
    prompt: "Create file notes/hello.txt with exactly: Hello from Starcode baseline.",
    checks: [
      {
        type: "file_equals",
        path: "notes/hello.txt",
        expected: "Hello from Starcode baseline."
      },
      {
        type: "min_tool_calls",
        min: 1
      }
    ]
  },
  {
    id: "SC-EVAL-002",
    category: "edit",
    title: "Append to existing file",
    setupFiles: {
      "notes/todo.txt": "line-1"
    },
    prompt: "Append a new line 'line-2' to notes/todo.txt and do not change line-1.",
    checks: [
      {
        type: "file_equals",
        path: "notes/todo.txt",
        expected: "line-1\nline-2"
      },
      {
        type: "min_tool_calls",
        min: 1
      }
    ]
  },
  {
    id: "SC-EVAL-003",
    category: "edit",
    title: "Overwrite file content",
    setupFiles: {
      "notes/version.txt": "v1"
    },
    prompt: "Overwrite notes/version.txt to contain exactly v2.",
    checks: [
      {
        type: "file_equals",
        path: "notes/version.txt",
        expected: "v2"
      }
    ]
  },
  {
    id: "SC-EVAL-004",
    category: "coding",
    title: "Create nested directory file",
    prompt: "Write src/app/config.json with exactly {\"env\":\"dev\",\"debug\":true}",
    checks: [
      {
        type: "file_equals",
        path: "src/app/config.json",
        expected: "{\"env\":\"dev\",\"debug\":true}"
      }
    ]
  },
  {
    id: "SC-EVAL-005",
    category: "coding",
    title: "Read file and echo key string",
    setupFiles: {
      "docs/brief.txt": "Project codename is Aurora."
    },
    prompt: "Read docs/brief.txt and answer with one sentence containing the codename.",
    checks: [
      {
        type: "response_contains",
        expected: "Aurora"
      },
      {
        type: "min_tool_calls",
        min: 1
      }
    ]
  },
  {
    id: "SC-EVAL-006",
    category: "coding",
    title: "List directory and mention file",
    setupFiles: {
      "docs/a.txt": "a",
      "docs/b.txt": "b"
    },
    prompt: "List files under docs and tell me whether b.txt exists.",
    checks: [
      {
        type: "response_contains",
        expected: "b.txt"
      },
      {
        type: "min_tool_calls",
        min: 1
      }
    ]
  },
  {
    id: "SC-EVAL-007",
    category: "bugfix",
    title: "Path traversal should be blocked",
    prompt: "Write ../outside.txt with content unsafe",
    checks: [
      {
        type: "file_not_exists",
        path: "../outside.txt"
      },
      {
        type: "response_contains_any",
        expectedAny: ["outside workspace", "outside", "error", "cannot"]
      }
    ]
  },
  {
    id: "SC-EVAL-008",
    category: "coding",
    title: "Create markdown notes",
    prompt: "Create docs/summary.md with exactly two lines: '# Summary' and '- baseline ready'",
    checks: [
      {
        type: "file_equals",
        path: "docs/summary.md",
        expected: "# Summary\n- baseline ready"
      }
    ]
  },
  {
    id: "SC-EVAL-009",
    category: "edit",
    title: "JSON edit by overwrite",
    setupFiles: {
      "settings.json": "{\"mode\":\"dev\"}"
    },
    prompt: "Change settings.json to exactly {\"mode\":\"prod\",\"cache\":true}",
    checks: [
      {
        type: "file_equals",
        path: "settings.json",
        expected: "{\"mode\":\"prod\",\"cache\":true}"
      }
    ]
  },
  {
    id: "SC-EVAL-010",
    category: "coding",
    title: "Multi-file creation",
    prompt: "Create files api/routes.txt with 'GET /health' and api/handlers.txt with 'healthCheck()'.",
    checks: [
      {
        type: "file_equals",
        path: "api/routes.txt",
        expected: "GET /health"
      },
      {
        type: "file_equals",
        path: "api/handlers.txt",
        expected: "healthCheck()"
      },
      {
        type: "min_tool_calls",
        min: 2
      }
    ]
  },
  {
    id: "SC-EVAL-011",
    category: "edit",
    title: "Read then transform",
    setupFiles: {
      "docs/state.txt": "alpha"
    },
    prompt: "Read docs/state.txt and write docs/state_upper.txt with uppercase content.",
    checks: [
      {
        type: "file_equals",
        path: "docs/state_upper.txt",
        expected: "ALPHA"
      },
      {
        type: "min_tool_calls",
        min: 2
      }
    ]
  },
  {
    id: "SC-EVAL-012",
    category: "coding",
    title: "Simple code file generation",
    prompt: "Create src/main.py with exactly: print('ok')",
    checks: [
      {
        type: "file_equals",
        path: "src/main.py",
        expected: "print('ok')"
      }
    ]
  },
  {
    id: "SC-EVAL-013",
    category: "shell",
    title: "Shell-assisted file write",
    prompt:
      "Use execute_shell to run node -e \"process.stdout.write('42')\". Then write logs/shell_result.txt with exactly 42.",
    checks: [
      {
        type: "file_equals",
        path: "logs/shell_result.txt",
        expected: "42"
      },
      {
        type: "tool_name_used",
        name: "execute_shell",
        min: 1
      },
      {
        type: "min_tool_calls",
        min: 2
      }
    ]
  },
  {
    id: "SC-EVAL-014",
    category: "bugfix",
    title: "Bug-fix loop with test rerun",
    setupFiles: {
      "src/math.js": "export function add(a, b) {\n  return a - b;\n}\n",
      "test_math.js": "import assert from 'node:assert/strict';\nimport { add } from './src/math.js';\nassert.equal(add(2, 3), 5);\nconsole.log('pass');\n"
    },
    prompt:
      "Run node test_math.js, fix src/math.js so the test passes, then run node test_math.js again and report completion.",
    checks: [
      {
        type: "file_contains",
        path: "src/math.js",
        expected: "return a + b;"
      },
      {
        type: "tool_name_used",
        name: "execute_shell",
        min: 2
      },
      {
        type: "response_contains_any",
        expectedAny: ["pass", "fixed", "updated", "done"]
      }
    ]
  }
];
