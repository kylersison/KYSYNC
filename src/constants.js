// Shared game constants. Tweak feel here.

export const LANE_COUNT = 5;

// event.code values, so the layout works on any keyboard language (JIS, US, etc.)
export const LANE_KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'];
export const LANE_LABELS = ['D', 'F', 'J', 'K', 'L'];
export const LANE_COLORS = ['#3ddc84', '#ff4d6d', '#ffd23f', '#3fa9ff', '#ff8a3d'];

// Hit windows in seconds (± from the note's time).
export const WINDOWS = {
  perfect: 0.040,
  great: 0.080,
  good: 0.120,
};

export const POINTS = { perfect: 100, great: 70, good: 40 };
export const ACCURACY_WEIGHT = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };

export const SUSTAIN_POINTS_PER_SEC = 60;
// Releasing a hold this close to its end still counts as a full hold.
export const HOLD_RELEASE_GRACE = 0.10;

export const COMBO_PER_MULT = 10;
export const MAX_MULT = 4;

export const DIFFICULTY_ORDER = ['easy', 'medium', 'hard', 'expert'];

// Seconds of silence before the song starts, so the first notes can scroll in.
export const LEAD_IN = 2.0;
