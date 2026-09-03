function pad(value: number, width = 2): string {
    return value.toString().padStart(width, "0");
}

/** 2026-08-01 */
export function dayStamp(time: number): string {
    const date = new Date(time);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 2026-08-01_22-41-27 */
export function secondStamp(time: number): string {
    const date = new Date(time);
    return `${dayStamp(time)}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** 2026-08-01_22-41-27-123, unique enough that consecutive frames cannot overwrite each other. */
export function millisecondStamp(time: number): string {
    return `${secondStamp(time)}-${pad(new Date(time).getMilliseconds(), 3)}`;
}
