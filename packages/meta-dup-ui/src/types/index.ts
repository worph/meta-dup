/**
 * Type definitions for meta-dup-ui
 */

export interface FileInfo {
    hashId: string;
    filePath: string;
    title?: string;
    sha256?: string;
    sizeByte?: number;
    year?: number;
    season?: number;
    episode?: number;
    fileType?: string;
}

export interface DuplicateGroup {
    key: string;
    files: FileInfo[];
}

export interface DuplicateStats {
    hashGroupCount: number;
    hashFileCount: number;
    titleGroupCount: number;
    titleFileCount: number;
    totalFilesTracked: number;
    lastUpdated: string;
}

export interface DuplicateData {
    hashDuplicates: DuplicateGroup[];
    titleDuplicates: DuplicateGroup[];
    stats: DuplicateStats;
    computedAt: string;
}

export interface HealthStatus {
    status: 'ok' | 'degraded';
    service: string;
    redis: boolean;
    stats: {
        filesTracked: number;
        hashDuplicates: number;
        titleDuplicates: number;
    };
    timestamp: string;
}
