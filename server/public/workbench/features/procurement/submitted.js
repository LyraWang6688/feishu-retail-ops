/** 采购预览区的已报货摘要 / 明细懒加载控制。 */
export const createSubmittedController = ({ config, api, state, paint, toast }) => {
  const view = () => ({
    expanded: state.submittedExpanded,
    detailLoading: state.submittedDetailLoading,
    hasMore: state.submitted.length < state.submittedTotal,
  });

  const mergeDetail = (batchNo, detail) => {
    if (!detail) return;
    state.submitted = state.submitted.map((batch) => (batch.batch_no === batchNo
      ? { ...batch, ...detail, is_today: batch.is_today }
      : batch));
  };

  const ensureDetail = async (batchNo, { silent = false } = {}) => {
    const batch = state.submitted.find((row) => row.batch_no === batchNo);
    if (batch?.products?.length) return batch;
    if (state.submittedDetailLoading.has(batchNo)) return null;
    state.submittedDetailLoading.add(batchNo);
    if (state.tab === 'pending') paint();
    try {
      const body = await api.loadSubmittedDetail(batchNo);
      mergeDetail(batchNo, body?.batch);
      return body?.batch || null;
    } catch (error) {
      if (!silent) toast(error?.message || config.texts.loadFailed);
      return null;
    } finally {
      state.submittedDetailLoading.delete(batchNo);
      if (state.tab === 'pending') paint();
    }
  };

  const load = async ({ append = false } = {}) => {
    if (state.submittedListLoading) return;
    state.submittedListLoading = true;
    try {
      const body = await api.loadSubmitted({ offset: append ? state.submitted.length : 0, limit: 20 });
      const rows = body?.batches || [];
      state.submitted = append ? [...state.submitted, ...rows] : rows;
      state.submittedTotal = Number(body?.total) || state.submitted.length;
      const today = state.submitted.filter((batch) => batch.is_today);
      for (const batch of today) state.submittedExpanded.add(batch.batch_no);
      await Promise.all(today.map((batch) => ensureDetail(batch.batch_no, { silent: true })));
    } catch {
      if (!append) { state.submitted = []; state.submittedTotal = 0; }
    } finally {
      state.submittedListLoading = false;
      if (state.tab === 'pending') paint();
    }
  };

  const toggle = async (batchNo) => {
    if (state.submittedExpanded.has(batchNo)) {
      state.submittedExpanded.delete(batchNo);
      paint();
      return;
    }
    await ensureDetail(batchNo);
    state.submittedExpanded.add(batchNo);
    paint();
  };

  const prepareModify = async (batchNo) => {
    await ensureDetail(batchNo);
    return state.submitted.find((row) => row.batch_no === batchNo) || null;
  };

  return { load, toggle, prepareModify, view };
};
