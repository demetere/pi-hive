---
name: Coder
model: inherit
thinking: medium
tags: [implementation]

capabilities:
  filesystem:
    - path: .
      operations: [read, create, update, delete]
      include: ["src/**", "tests/**"]
      exclude: ["**/.env*", "**/secrets/**"]
  shell: [inspect, test, build, execute-code]
  git: true
  external-network: false
  artifact: [read, write]
---

Implement and verify scoped project changes.
