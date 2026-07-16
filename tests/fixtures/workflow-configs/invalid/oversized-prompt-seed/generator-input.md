# Oversized prompt generator input

After W01-W03 resolve the applicable byte limit, create the boundary input with
`writeRepeatedFile(outputPath, resolvedLimit + 1, "x")`. The committed agent is
intentionally small so W00 does not guess a deferred size constant.
