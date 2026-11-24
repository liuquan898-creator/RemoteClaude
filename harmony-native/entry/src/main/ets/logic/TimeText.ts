const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;

/** 某一时刻在指定时区里的年、月（1 起）、日，以及从 1970-01-01 起的日序号（用来判断同一天、前一天） */
interface DayFields {
  year: number;
  month: number;
  day: number;
  dayIndex: number;
}

function dayFields(ms: number, offsetMinutes: number | null): DayFields {
  let year: number;
  let month: number;
  let day: number;
  if (offsetMinutes === null) {
    const d = new Date(ms);
    year = d.getFullYear();
    month = d.getMonth();
    day = d.getDate();
  } else {
    const d = new Date(ms + offsetMinutes * MINUTE);
    year = d.getUTCFullYear();
    month = d.getUTCMonth();
    day = d.getUTCDate();
  }
  return { year, month: month + 1, day, dayIndex: Math.round(Date.UTC(year, month, day) / DAY) };
}

/** 会话最后活动时间的简短说法。不依赖鸿蒙接口，有单元测试。对照安卓端 ui/TimeText.kt */
export class TimeText {
  /**
   * 刚刚、5 分钟前、3 小时前、昨天、11月12日、2025年3月4日；at 为 0 时返回空串。
   * @param at 会话最后活动的时刻（毫秒）
   * @param now 现在（毫秒），一般传 Date.now()
   * @param offsetMinutes 按哪个时区算日期：比 UTC 早多少分钟（北京时间是 480）。
   *   不传或 null 用手机当前的时区（对照 Kotlin 的 TimeZone.getDefault()）
   */
  static ago(at: number, now: number, offsetMinutes: number | null = null): string {
    if (at <= 0) return '';
    const diff = now - at;
    if (diff < MINUTE) return '刚刚'; // 电脑和手机的时钟差一点时 diff 可能是负的
    if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
    const then = dayFields(at, offsetMinutes);
    const today = dayFields(now, offsetMinutes);
    if (then.dayIndex === today.dayIndex) return `${Math.floor(diff / HOUR)} 小时前`;
    if (then.dayIndex === today.dayIndex - 1) return '昨天';
    const md = `${then.month}月${then.day}日`;
    return then.year === today.year ? md : `${then.year}年${md}`;
  }
}
