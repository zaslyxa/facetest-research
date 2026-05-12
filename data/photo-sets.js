window.PHOTO_SET_MANIFEST = {
  defaultSetId: "set-a",
  sets: [
    {
      id: "set-a",
      label: "Группа 1",
      stimuli: createNumberStimuli("a")
    },
    {
      id: "set-b",
      label: "Группа 2",
      stimuli: createNumberStimuli("b")
    },
    {
      id: "set-c",
      label: "Группа 3",
      stimuli: createNumberStimuli("c")
    }
  ]
};

function createNumberStimuli(prefix) {
  return Array.from({ length: 20 }, (_, index) => {
    const value = index + 1;
    return {
      id: `${prefix}-${String(value).padStart(3, "0")}`,
      type: "number",
      value
    };
  });
}
