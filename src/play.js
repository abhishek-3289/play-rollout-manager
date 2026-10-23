import { requestJson } from './http.js';

export function createPlayClient({ fetchImpl, baseUrl, token, packageName }) {
  const root = `${baseUrl}/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
  const headers = { Authorization: `Bearer ${token}` };
  const call = (label, method, path, body) =>
    requestJson(fetchImpl, { label: `Google Play ${label}`, method, url: `${root}${path}`, headers, body });

  return {
    async insertEdit() {
      const edit = await call('edits.insert', 'POST', '/edits', {});
      if (!edit.id) throw new Error('Google Play edits.insert returned no edit id');
      return edit.id;
    },
    getTrack(editId, track) {
      return call('edits.tracks.get', 'GET', `/edits/${encodeURIComponent(editId)}/tracks/${encodeURIComponent(track)}`);
    },
    updateTrack(editId, track, body) {
      return call('edits.tracks.update', 'PUT', `/edits/${encodeURIComponent(editId)}/tracks/${encodeURIComponent(track)}`, body);
    },
    commitEdit(editId, changesNotSentForReview) {
      const query = changesNotSentForReview ? '?changesNotSentForReview=true' : '';
      return call('edits.commit', 'POST', `/edits/${encodeURIComponent(editId)}:commit${query}`);
    },
    deleteEdit(editId) {
      return call('edits.delete', 'DELETE', `/edits/${encodeURIComponent(editId)}`);
    },
  };
}
