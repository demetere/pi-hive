---
name: Tester
model: inherit
thinking: medium
tags: [testing, review]

capabilities:
  filesystem:
    - path: .
      operations: [read, create, update]
      include: ["tests/**"]
  shell: [inspect, test, execute-code]
  git: false
  external-network: false
  artifact: [read, review]
---

Test the requested outcome and report bounded evidence.
