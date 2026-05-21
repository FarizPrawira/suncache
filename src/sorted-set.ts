interface ZEntry {
  score: number;
  member: string;
}

export class SortedSet {
  private scores = new Map<string, number>();
  private sorted: ZEntry[] = [];

  add(score: number, member: string): 0 | 1 {
    const existing = this.scores.get(member);
    if (existing !== undefined) {
      if (existing !== score) {
        this.removeFromSorted(existing, member);
        this.scores.set(member, score);
        this.insertSorted(score, member);
      }
      return 0;
    }
    this.scores.set(member, score);
    this.insertSorted(score, member);
    return 1;
  }

  rem(member: string): boolean {
    const score = this.scores.get(member);
    if (score === undefined) return false;
    this.scores.delete(member);
    this.removeFromSorted(score, member);
    return true;
  }

  score(member: string): number | undefined {
    return this.scores.get(member);
  }

  incrBy(delta: number, member: string): number {
    const current = this.scores.get(member) ?? 0;
    const next = current + delta;
    if (Number.isNaN(next)) {
      throw new TypeError("resulting score is NaN");
    }
    this.add(next, member);
    return next;
  }

  card(): number {
    return this.sorted.length;
  }

  rangeByRank(start: number, stop: number): string[] {
    return this.sliceByRank(start, stop, false);
  }

  revRangeByRank(start: number, stop: number): string[] {
    return this.sliceByRank(start, stop, true);
  }

  rangeByScore(min: number, max: number): string[] {
    if (min > max) return [];
    const lo = this.bisectScore(min, true);
    const hi = this.bisectScore(max, false);
    const out: string[] = [];
    for (let i = lo; i < hi; i++) out.push(this.sorted[i].member);
    return out;
  }

  private sliceByRank(
    start: number,
    stop: number,
    reverse: boolean,
  ): string[] {
    const len = this.sorted.length;
    if (len === 0) return [];
    const s = start < 0 ? Math.max(0, len + start) : start;
    const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
    if (s > e || s >= len || e < 0) return [];
    const out: string[] = [];
    if (reverse) {
      // Rank 0 in reverse view = last element in ascending sorted array.
      const from = len - 1 - s;
      const to = len - 1 - e;
      for (let i = from; i >= to; i--) out.push(this.sorted[i].member);
    } else {
      for (let i = s; i <= e; i++) out.push(this.sorted[i].member);
    }
    return out;
  }

  private insertSorted(score: number, member: string): void {
    const idx = this.bisect(score, member);
    this.sorted.splice(idx, 0, { score, member });
  }

  private removeFromSorted(score: number, member: string): void {
    const idx = this.bisect(score, member);
    if (this.sorted[idx]?.member === member) {
      this.sorted.splice(idx, 1);
    }
  }

  // Locates the leftmost position where (score, member) belongs, ordering by
  // score ascending and breaking ties lexicographically by member.
  private bisect(score: number, member: string): number {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const e = this.sorted[mid];
      if (e.score < score || (e.score === score && e.member < member)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  // leftmost=true returns first index with score >= target;
  // leftmost=false returns first index with score > target.
  private bisectScore(score: number, leftmost: boolean): number {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const s = this.sorted[mid].score;
      if (leftmost ? s < score : s <= score) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
