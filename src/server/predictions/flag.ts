/** Predictions (free points, no money) are hidden everywhere unless MEMESTREAM_PREDICTIONS=1. */
export const predictionsEnabled = () => process.env.MEMESTREAM_PREDICTIONS === "1";
