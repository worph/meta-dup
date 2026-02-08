/**
 * Formatting utilities
 */

export function formatNumber(num: number): string {
    return num.toLocaleString();
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleString();
}

export function getFilename(path: string): string {
    return path.split('/').pop() || path;
}

export function truncateHash(hash: string, length: number = 16): string {
    if (hash.length <= length) return hash;
    return `${hash.substring(0, length)}...`;
}
