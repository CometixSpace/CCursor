import { Code, ConnectError } from '@connectrpc/connect';

interface Mailbox {
    next: bigint;
    pending: Map<bigint, string>;
    receive?: (data: string) => void;
    timer: ReturnType<typeof setTimeout>;
}

const mailboxes = new Map<string, Mailbox>();
const closed = new Set<string>();

function mailbox(requestId: string): Mailbox {
    let box = mailboxes.get(requestId);
    if (!box) {
        // BidiAppend may arrive before its SSE endpoint. Keep undecoded bytes
        // until that endpoint has selected the Agent or Inference schema.
        const timer = setTimeout(() => mailboxes.delete(requestId), 60_000);
        timer.unref();
        box = { next: 0n, pending: new Map(), timer };
        mailboxes.set(requestId, box);
    }
    return box;
}

function flush(box: Mailbox): void {
    while (box.receive && box.pending.has(box.next)) {
        const data = box.pending.get(box.next)!;
        box.receive(data);
        box.pending.delete(box.next++);
    }
}

export function appendBidiMessage(requestId: string, seqno: bigint, data: string): void {
    if (closed.has(requestId)) return; // Late retry of an already acknowledged append.
    if (!/^(?:[\da-f]{2})+$/i.test(data) || seqno < 0n) throw new ConnectError('Invalid BidiAppend payload.', Code.InvalidArgument);
    const box = mailbox(requestId);
    if (seqno < box.next || box.pending.has(seqno)) return;
    if (box.pending.size >= 256) throw new ConnectError('Too many pending BidiAppend messages.', Code.ResourceExhausted);
    box.pending.set(seqno, data);
    flush(box);
}

export function registerBidiReceiver(requestId: string, receive: (data: string) => void): () => void {
    const box = mailbox(requestId);
    if (box.receive) throw new ConnectError('SSE request is already attached.', Code.AlreadyExists);
    clearTimeout(box.timer);
    box.receive = receive;
    try { flush(box); }
    catch (error) { mailboxes.delete(requestId); throw error; }
    return () => {
        mailboxes.delete(requestId);
        closed.add(requestId);
        const timer = setTimeout(() => closed.delete(requestId), 60_000);
        timer.unref();
    };
}
