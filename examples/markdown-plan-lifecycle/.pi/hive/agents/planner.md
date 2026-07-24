---
name: Markdown Delivery Lead
model: inherit
thinking: medium
tags: [planning, implementation]

capabilities:
  filesystem:
    - path: .
      operations: [read, create, update]
      include: ["src/**", "tests/**"]
      exclude: ["**/.env*", "**/secrets/**"]
  shell: [inspect, test, execute-code]
  git: false
  external-network: false
  human-input: true
  artifact: [read, write, review]
---

Author a bounded Markdown plan, execute it within effective authority, and finish with verified evidence.
