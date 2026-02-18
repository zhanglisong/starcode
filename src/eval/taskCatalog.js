export const evalLiteTasks = [
  {
    id: "SC-EVAL-001",
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
    title: "Simple code file generation",
    prompt: "Create src/main.py with exactly: print('ok')",
    checks: [
      {
        type: "file_equals",
        path: "src/main.py",
        expected: "print('ok')"
      }
    ]
  }
];
