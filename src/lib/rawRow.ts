/** Merge Supabase column fields with firestore-shaped `raw_data` for Mobile and Web clients. */
export function mergeRawRow<T extends { id: string; rawData?: unknown }>(
  row: T,
): Record<string, unknown> {
  const raw =
    row.rawData && typeof row.rawData === 'object' && !Array.isArray(row.rawData)
      ? (row.rawData as Record<string, unknown>)
      : {};
  const { rawData: _omit, ...cols } = row;
  const cleanCols: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cols)) {
    // Only overwrite rawData if column has an actual value (not null/undefined/empty string when raw has value)
    if (v !== null && v !== undefined && (v !== '' || !raw[k])) {
      cleanCols[k] = v;
    }
  }

  const merged = { ...raw, ...cleanCols, id: row.id } as Record<string, any>;

  // Guaranteed Audio URL extraction across all possible legacy formats
  const audio =
    merged.audioFile ||
    merged.audioUrl ||
    merged.url ||
    merged.fileUrl ||
    (merged.audioUrls && typeof merged.audioUrls === 'object' ? merged.audioUrls.full : null) ||
    '';

  if (audio) {
    merged.audioFile = audio;
    merged.audioUrl = audio;
    if (!merged.audioUrls || typeof merged.audioUrls !== 'object') {
      merged.audioUrls = { full: audio };
    } else if (!merged.audioUrls.full) {
      merged.audioUrls.full = audio;
    }
  }

  // Guaranteed Lead Singer normalization
  const leadSinger =
    merged.leadSinger ||
    merged.lead_singer ||
    merged.lead ||
    merged.singer ||
    merged.leadVocalist ||
    merged.lead_vocalist ||
    '';
  if (leadSinger) {
    merged.leadSinger = leadSinger;
    merged.lead_singer = leadSinger;
  }

  // Guaranteed Writer / Author normalization
  const writer =
    merged.writer ||
    merged.songWriter ||
    merged.song_writer ||
    merged.author ||
    merged.composer ||
    '';
  if (writer) {
    merged.writer = writer;
    merged.songWriter = writer;
  }

  // Conductor & Band personnel normalization
  const conductor = merged.conductor || merged.conductorGuide || merged.conductor_guide || '';
  if (conductor) {
    merged.conductor = conductor;
    merged.conductorGuide = conductor;
  }

  const drummer = merged.drummer || '';
  if (drummer) merged.drummer = drummer;

  const leadGuitarist = merged.leadGuitarist || merged.lead_guitarist || '';
  if (leadGuitarist) {
    merged.leadGuitarist = leadGuitarist;
    merged.lead_guitarist = leadGuitarist;
  }

  const leadKeyboardist = merged.leadKeyboardist || merged.lead_keyboardist || '';
  if (leadKeyboardist) {
    merged.leadKeyboardist = leadKeyboardist;
    merged.lead_keyboardist = leadKeyboardist;
  }

  const bassGuitarist = merged.bassGuitarist || merged.bass_guitarist || '';
  if (bassGuitarist) {
    merged.bassGuitarist = bassGuitarist;
    merged.bass_guitarist = bassGuitarist;
  }

  // Solfas normalization
  const solfas = merged.solfas || merged.solfa || '';
  if (solfas) {
    merged.solfas = solfas;
    merged.solfa = solfas;
  }

  return merged;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
