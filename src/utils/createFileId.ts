import md5 from 'md5';

export default function createFileId(events: any[]): string {
    return md5(events.map(x => x.event_id).join(';'));
}