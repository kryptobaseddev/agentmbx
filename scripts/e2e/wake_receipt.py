"""Read-only evidence for a scratch-mailbox wake test; never marks mail read/acked."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3


def inspect_receipt(home, message_id, agent, token):
    uri = (Path(home) / 'mbx.db').resolve().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(uri, uri=True)) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        request = db.execute('SELECT thread, from_addr, envelope FROM messages WHERE id=?', (message_id,)).fetchone()
        if request is None:
            raise ValueError('Original wake request is missing')
        thread, sender, raw = request
        envelope = json.loads(raw)
        host = sender.rsplit('@', 1)[1]
        recipient = agent + '@' + host
        if recipient not in envelope['to']:
            raise ValueError('Original request was not addressed to the expected agent')
        delivery = db.execute('SELECT state FROM deliveries WHERE msg_id=? AND agent=?', (message_id, agent)).fetchone()
        matches = db.execute('''SELECT id, envelope FROM messages WHERE thread=? AND reply_to=?
            AND from_addr=? AND kind='reply' AND body=? AND origin='local' AND trust='local' ''',
            (thread, message_id, recipient, token)).fetchall()
        reply_ids = []
        for reply_id, raw_reply in matches:
            reply = json.loads(raw_reply)
            if (reply.get('id') == reply_id and reply.get('thread') == thread and
                reply.get('reply_to') == message_id and reply.get('from') == recipient and
                reply.get('kind') == 'reply' and reply.get('body') == token and sender in reply.get('to', [])):
                reply_ids.append(reply_id)
        acked = delivery is not None and delivery[0] == 'acked'
        return {'message_id': message_id, 'reply_ids': reply_ids, 'acked': acked,
                'receipt_verified': bool(reply_ids) and acked}
