import blessed from "blessed";

export function createValidatorLog(grid, validatorLabel, screen) {
  // When validator mode is active, the grid layout shifts:
  // Execution log: rows 1-2, Consensus log: rows 3-4, Validator log: rows 5-6
  const validatorLog = grid.set(5, 0, 2, 7, blessed.box, {
    label: `${validatorLabel} (Validator)`,
    content: `Loading ${validatorLabel} validator logs`,
    border: {
      type: "line",
      fg: "green",
    },
    tags: true,
    shrink: true,
    wrap: true,
  });

  return validatorLog;
}
