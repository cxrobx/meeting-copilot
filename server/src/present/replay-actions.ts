/**
 * Which of a stored meeting's actions the replay shows.
 *
 * A meeting keeps two kinds of summary. The rolling one (`params._rolling`) is
 * rewritten in place every couple of minutes while the meeting runs; session.stop
 * then writes the end-of-meeting summary from the full transcript. Both rows are
 * saved — the rolling one so it survives a reload mid-meeting — so a replay read
 * straight from the table showed the same summary twice.
 *
 * The rolling card is a draft of the end-of-meeting one, so it is hidden once
 * that summary COMPLETED. When it failed or was cancelled (the stop grace
 * window, the worker queue), the rolling card is the only full summary there
 * is, and it stays. A summary asked for mid-meeting doesn't count: it can be
 * scoped to the recent discussion, and it predates the meeting's end.
 */

/**
 * session.stop stamps this on the end-of-meeting summary, and the replay finds
 * it by it — every meeting stored before this module existed carries it too.
 */
export const END_OF_MEETING_SUMMARY_DESCRIPTION = 'Auto-generated end-of-meeting summary';

export interface StoredActionRow {
  type: string;
  state: string;
  description: string;
  params: string | null;
}

function isRolling(row: StoredActionRow): boolean {
  if (!row.params) return false;
  try {
    return JSON.parse(row.params)?._rolling === true;
  } catch {
    return false;
  }
}

export function hideSupersededRollingSummaries<T extends StoredActionRow>(rows: T[]): T[] {
  const finalCompleted = rows.some(
    (r) =>
      r.type === 'summary' &&
      r.state === 'completed' &&
      r.description === END_OF_MEETING_SUMMARY_DESCRIPTION,
  );
  if (!finalCompleted) return rows;
  return rows.filter((r) => !(r.type === 'summary' && isRolling(r)));
}
