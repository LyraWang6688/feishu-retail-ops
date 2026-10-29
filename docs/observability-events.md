# 观测事件目录（自动生成）

> ⚠️ 本文件由 `server/scripts/observability-events.mjs` 生成，**不要手改**。
> 新增/改名日志事件后跑：`cd server && pnpm run observability:events`。

共 **457** 个事件。按前缀分组：

## after_sales

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `after_sales.cash.method` | 1 | src/services/afterSalesService.js |
| `after_sales.count.applied` | 1 | src/services/afterSalesService.js |
| `after_sales.executed` | 1 | src/services/afterSalesService.js |
| `after_sales.return_funds.no_original_payment` | 1 | src/services/afterSalesService.js |
| `after_sales.return_funds.payment_status_updated` | 1 | src/services/afterSalesService.js |
| `after_sales.return_funds.uncovered` | 1 | src/services/afterSalesService.js |
| `after_sales.skipped.already_done` | 1 | src/services/afterSalesService.js |
| `after_sales.stock.skipped` | 1 | src/services/afterSalesService.js |

## auth

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `auth.misconfigured` | 1 | src/middleware/auth.js |
| `auth.rejected` | 1 | src/middleware/auth.js |

## bitable

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `bitable.record.batch_create_failed` | 2 | src/config/alerts.js<br>src/config/batchWriteTelemetry.js |
| `bitable.record.batch_created` | 2 | src/config/alerts.js<br>src/config/batchWriteTelemetry.js |
| `bitable.record.batch_delete_failed` | 2 | src/config/alerts.js<br>src/config/batchWriteTelemetry.js |
| `bitable.record.batch_deleted` | 2 | src/config/alerts.js<br>src/config/batchWriteTelemetry.js |
| `bitable.record.batch_read` | 1 | src/services/v1BitableGateway.js |
| `bitable.record.batch_started` | 1 | src/utils/batchWriteTelemetry.js |
| `bitable.record.batch_update_failed` | 2 | src/config/alerts.js<br>src/config/batchWriteTelemetry.js |
| `bitable.record.batch_updated` | 2 | src/config/alerts.js<br>src/config/batchWriteTelemetry.js |
| `bitable.record.batch_write_mismatch` | 5 | src/config/alerts.js<br>src/services/v1BitableGateway.js |
| `bitable.record.create_failed` | 2 | src/config/alerts.js<br>src/services/v1BitableGateway.js |
| `bitable.record.created` | 1 | src/services/v1BitableGateway.js |
| `bitable.record.update_failed` | 2 | src/config/alerts.js<br>src/services/v1BitableGateway.js |
| `bitable.record.updated` | 1 | src/services/v1BitableGateway.js |

## cleanup

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `cleanup.ttl.completed` | 1 | src/utils/uploadCleanup.js |
| `cleanup.ttl.failed` | 1 | src/utils/uploadCleanup.js |
| `cleanup.ttl.started` | 1 | src/utils/uploadCleanup.js |
| `cleanup.unlink_failed` | 1 | src/utils/uploadCleanup.js |

## client

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `client.resource.failed` | 1 | src/utils/uiTapReport.js |

## hm

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `hm.bamamei.online` | 1 | src/config/larkJsapi.js |

## http

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `http.request.completed` | 1 | src/app.js |
| `http.unhandled_error` | 1 | src/app.js |

## idempotency

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `idempotency.batch_create_failed` | 1 | src/infrastructure/idempotencyKey.js |
| `idempotency.reconcile_read_failed` | 1 | src/infrastructure/idempotencyKey.js |
| `idempotency.reconciled_after_unknown` | 1 | src/infrastructure/idempotencyKey.js |
| `idempotency.reused` | 3 | src/infrastructure/idempotencyKey.js<br>src/services/inventory/purchaseBatch.js |
| `idempotency.unknown_outcome` | 1 | src/infrastructure/idempotencyKey.js |

## inventory

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `inventory.adjustment.count.applied` | 1 | src/services/inventoryAdjustmentService.js |
| `inventory.adjustment.count.replayed` | 1 | src/services/inventoryAdjustmentService.js |
| `inventory.adjustment.season.applied` | 1 | src/services/inventoryAdjustmentService.js |
| `inventory.change.applied` | 4 | src/services/inventory/executeOperation.js<br>src/services/inventory/purchaseBatch.js<br>src/services/inventory/purchaseReturnBatch.js<br>…等 4 个文件 |
| `inventory.change.failed` | 1 | src/config/alerts.js |
| `inventory.sample_candidates.failed` | 2 | src/services/inventory/executeOperation.js<br>src/services/inventory/saleBatch.js |
| `inventory.sample.promoted` | 1 | src/services/inventory/samplePromotion.js |
| `inventory.state.transitioned` | 1 | src/services/inventory/stateTransition.js |

## label

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `label.print.enqueue` | 1 | src/config/timing.js |
| `label.print.sizes_overflow` | 1 | src/services/labelPrintArtifactService.js |
| `label.print.sizes_shrunk` | 1 | src/services/labelPrintArtifactService.js |
| `label.print.vertical_overflow` | 1 | src/services/labelPrintArtifactService.js |

## label_print

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `label_print.canvas.fitting_equals_no_rotation` | 1 | src/services/labelPrintQueueRuntime.js |
| `label_print.canvas.portrait_prerequisite` | 1 | src/services/labelPrintQueueRuntime.js |
| `label_print.cleanup.done` | 1 | src/services/labelPrintQueueService.js |
| `label_print.cleanup.failed` | 1 | src/services/labelPrintQueueService.js |
| `label_print.device.ack.failed` | 1 | src/routes/labelPrintDevice.js |
| `label_print.device.artifact.failed` | 1 | src/routes/labelPrintDevice.js |
| `label_print.device.heartbeat_failed` | 1 | src/routes/labelPrintDevice.js |
| `label_print.device.next.failed` | 1 | src/routes/labelPrintDevice.js |
| `label_print.device.pending.failed` | 1 | src/routes/labelPrintDevice.js |
| `label_print.device.rejected` | 1 | src/routes/labelPrintDevice.js |
| `label_print.device.reprint.failed` | 1 | src/routes/labelPrintDevice.js |
| `label_print.device.status.failed` | 1 | src/routes/labelPrintDevice.js |
| `label_print.device.token_missing` | 2 | src/routes/labelPrintDevice.js<br>src/services/labelPrintQueueRuntime.js |
| `label_print.job.claimed` | 1 | src/services/labelPrintQueueService.js |
| `label_print.job.done` | 1 | src/services/labelPrintQueueService.js |
| `label_print.job.enqueued` | 1 | src/services/labelPrintQueueService.js |
| `label_print.job.failed` | 2 | src/config/alerts.js<br>src/services/labelPrintQueueService.js |
| `label_print.job.late_failure_ignored` | 1 | src/services/labelPrintQueueService.js |
| `label_print.job.pending_listed` | 1 | src/services/labelPrintQueueService.js |
| `label_print.job.reprinted` | 1 | src/services/labelPrintQueueService.js |
| `label_print.job.reused` | 2 | src/services/labelPrintQueueService.js |
| `label_print.queue.ready` | 1 | src/services/labelPrintQueueRuntime.js |
| `label_print.scan.report` | 1 | src/routes/workbench/labels.js |
| `label_print.stream.backlog_failed` | 1 | src/routes/labelPrintDevice.js |
| `label_print.stream.connected` | 1 | src/routes/labelPrintDevice.js |
| `label_print.stream.disconnected` | 1 | src/routes/labelPrintDevice.js |
| `label_print.subscriber.failed` | 1 | src/services/labelPrintQueueService.js |

## lark

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `lark.after_sales.card.update.failed` | 1 | src/services/larkMvpService.js |
| `lark.after_sales.card.update.skipped` | 1 | src/services/larkMvpService.js |
| `lark.after_sales.card.update.started` | 1 | src/services/larkMvpService.js |
| `lark.after_sales.card.update.succeeded` | 1 | src/services/larkMvpService.js |
| `lark.after_sales.card.update.tick_failed` | 1 | src/services/larkMvpService.js |
| `lark.bitable.record_changed` | 1 | src/routes/larkEvents.js |
| `lark.bitable.record_changed.base_unconfigured` | 1 | src/routes/larkEvents.js |
| `lark.card.update.failed` | 1 | src/infrastructure/interactiveCardFeedback.js |
| `lark.card.update.skipped` | 1 | src/infrastructure/interactiveCardFeedback.js |
| `lark.card.update.started` | 1 | src/infrastructure/interactiveCardFeedback.js |
| `lark.card.update.succeeded` | 1 | src/infrastructure/interactiveCardFeedback.js |
| `lark.card.update.tick_failed` | 1 | src/infrastructure/interactiveCardFeedback.js |
| `lark.event.challenge` | 1 | src/routes/larkEvents.js |
| `lark.event.received` | 1 | src/routes/larkEvents.js |
| `lark.group.message.disabled` | 1 | src/services/larkMvpService.js |
| `lark.heartbeat.file_unreadable` | 1 | src/infrastructure/larkEventHeartbeat.js |
| `lark.heartbeat.write_failed` | 1 | src/infrastructure/larkEventHeartbeat.js |
| `lark.mvp.event.failed` | 1 | src/routes/larkEvents.js |
| `lark.mvp.health.checked` | 1 | src/routes/larkEvents.js |
| `lark.private_chat.disabled` | 1 | src/services/larkMvpService.js |
| `lark.private_chat.notice_failed` | 1 | src/services/larkMvpService.js |
| `lark.sales.accessory.list_failed` | 1 | src/services/salesEntryService.js |
| `lark.sales.card.fallback.failed` | 1 | src/services/larkMvpService.js |
| `lark.sales.card.fallback.sent` | 1 | src/services/larkMvpService.js |
| `lark.sales.detail.trade_type.resolve_failed` | 1 | src/services/salesOrderService.js |
| `lark.sales.group_buy_vouchers.list_failed` | 1 | src/services/larkMvpService.js |
| `lark.sales.live_inventory.loaded` | 1 | src/services/larkMvpService.js |
| `lark.sales.product_index.completeness_field_unreadable` | 1 | src/services/larkMvpService.js |
| `lark.sales.product_index.loaded` | 1 | src/services/larkMvpService.js |
| `lark.sales.product_info.gaps` | 1 | src/services/larkMvpService.js |
| `lark.sales.product_info.resolve_failed` | 1 | src/services/larkMvpService.js |
| `lark.sales.product_missing.blocked` | 1 | src/config/salesProductRegistration.js |
| `lark.sales.product_missing.guard_disabled` | 1 | src/config/salesProductRegistration.js |
| `lark.sales.product_missing.undetermined` | 1 | src/config/salesProductRegistration.js |
| `lark.sales.sample_candidates.failed` | 1 | src/services/sampleReplacementService.js |
| `lark.sales.sample_card.fallback.failed` | 1 | src/services/sampleReplacementService.js |
| `lark.sales.sample_card.fallback.sent` | 1 | src/services/sampleReplacementService.js |
| `lark.sales.sample_card.fallback.skipped` | 1 | src/services/sampleReplacementService.js |
| `lark.sales.sample_card.update.failed` | 1 | src/services/sampleReplacementService.js |
| `lark.sales.sample_card.update.skipped` | 1 | src/services/sampleReplacementService.js |
| `lark.sales.sample_card.update.started` | 1 | src/services/sampleReplacementService.js |
| `lark.sales.sample_card.update.succeeded` | 1 | src/services/sampleReplacementService.js |
| `lark.sales.sample_card.update.tick_failed` | 1 | src/services/sampleReplacementService.js |
| `lark.sales.sample_notice.failed` | 1 | src/services/sampleReplacementService.js |
| `lark.sales.sample_replacement.applied` | 1 | src/services/sampleReplacementService.js |
| `lark.sales.trade_type.resolve_failed` | 1 | src/services/larkMvpService.js |
| `lark.sdk.error` | 1 | src/utils/larkLogger.js |
| `lark.sdk.info` | 1 | src/utils/larkLogger.js |
| `lark.sdk.warn` | 1 | src/utils/larkLogger.js |

## log

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `log.event.unregistered.cache_hit` | 1 | src/utils/logger.js |
| `log.event.unregistered.cache_miss` | 1 | src/utils/logger.js |

## observability

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `observability.alert.failed` | 1 | src/services/alertNotifier.js |
| `observability.alert.sent` | 1 | src/services/alertNotifier.js |
| `observability.alert.skipped` | 1 | src/services/alertNotifier.js |

## perf

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `perf.request.completed` | 2 | src/config/alerts.js<br>src/utils/requestTiming.js |

## procurement

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `procurement.page.new_products_loaded` | 1 | src/config/procurementPage.js |
| `procurement.page.replenish_loaded` | 1 | src/config/procurementPage.js |
| `procurement.page.submit_accepted` | 1 | src/config/procurementPage.js |
| `procurement.page.submit_rejected` | 1 | src/config/procurementPage.js |
| `procurement.page.trade_type_unknown` | 1 | src/config/procurementPage.js |
| `procurement.page.write_task_ready` | 1 | src/config/procurementPage.js |

## product

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `product.tag_qr.assemble_incomplete` | 3 | src/services/tagQrCodeService.js |
| `product.tag_qr.batch_failed` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.change_criteria` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.disabled` | 3 | src/services/tagQrCodeService.js |
| `product.tag_qr.dispatch_failed` | 1 | src/routes/larkEvents.js |
| `product.tag_qr.failed` | 4 | src/services/tagQrCodeService.js |
| `product.tag_qr.field_id_unavailable` | 2 | src/services/tagQrCodeService.js |
| `product.tag_qr.not_wired` | 1 | src/routes/larkEvents.js |
| `product.tag_qr.number_change_unknown` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.number_mismatch` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.number_missing` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.overwriting` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.record_failed` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.record_id_mismatch` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.record_id_missing` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.skipped_existing` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.skipped_number_unchanged` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.sweep_disabled` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.sweep_done` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.sweep_dry_run` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.sweep_failed` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.sweep.disabled` | 1 | src/app.js |
| `product.tag_qr.sweep.done` | 1 | src/app.js |
| `product.tag_qr.sweep.failed` | 1 | src/app.js |
| `product.tag_qr.sweep.skipped` | 1 | src/app.js |
| `product.tag_qr.sweep.started` | 1 | src/app.js |
| `product.tag_qr.sweep.succeeded` | 1 | src/app.js |
| `product.tag_qr.sweep.tick_failed` | 1 | src/app.js |
| `product.tag_qr.sweep.too_soon` | 1 | src/app.js |
| `product.tag_qr.upgraded_to_record_id` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.used_assembled` | 1 | src/services/tagQrCodeService.js |
| `product.tag_qr.written` | 1 | src/services/tagQrCodeService.js |

## purchase

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `purchase.arrival.accept` | 1 | src/config/timing.js |
| `purchase.arrival.acceptance.skipped` | 1 | src/services/purchase/arrival.js |
| `purchase.arrival.inventory_applied.persist_failed` | 1 | src/services/purchase/arrival.js |
| `purchase.arrival.posted` | 1 | src/services/purchase/arrival.js |
| `purchase.arrival.reconcile.amount_missing` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.batch_arrival_failed` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.batch_arrival_skipped` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.card_supersede_failed` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.card_supersede_skipped` | 3 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.card_superseded` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.card_update_failed` | 2 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.card_update_failed_notice` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.confirm_duplicate` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.confirm_failed` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.failure_notice` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.posted` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.reply_failed` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.success_notice` | 2 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.task_read_failed` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.workbench_already_posted` | 2 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.workbench_plan_failed` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.workbench_rows_unavailable` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.arrival.reconcile.zero_actual_skipped` | 1 | src/services/purchaseArrivalConversationService.js |
| `purchase.batch_no.collision` | 1 | src/services/purchaseBatchNoGenerator.js |
| `purchase.batch_no.generated` | 1 | src/services/purchaseBatchNoGenerator.js |
| `purchase.batch.acceptance.no_record` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.batch.acceptance.nothing_to_write` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.batch.acceptance.written` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.batch.arrival_status.arrived.cache_hit` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.batch.arrival_status.arrived.cache_miss` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.batch.arrival_status.no_record` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.batch.arrival_status.pending.cache_hit` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.batch.arrival_status.pending.cache_miss` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.batch.document.exists` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.batch.document.no_record` | 2 | src/services/purchase/documentImages.js<br>src/services/purchaseOrderBatchService.js |
| `purchase.batch.order_amount.no_record` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.batch.order_amount.not_a_number` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.batch.order_amount.update_failed` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.batch.order_amount.written` | 1 | src/services/purchaseOrderBatchService.js |
| `purchase.card.update.failed` | 1 | src/services/larkMvpService.js |
| `purchase.card.update.skipped` | 1 | src/services/larkMvpService.js |
| `purchase.card.update.started` | 1 | src/services/larkMvpService.js |
| `purchase.card.update.succeeded` | 1 | src/services/larkMvpService.js |
| `purchase.card.update.tick_failed` | 1 | src/services/larkMvpService.js |
| `purchase.group_notice.failed` | 1 | src/services/purchase/messaging.js |
| `purchase.group_notice.sent` | 1 | src/services/purchase/messaging.js |
| `purchase.group_notice.skipped` | 1 | src/services/purchase/messaging.js |
| `purchase.group.message.remembered` | 1 | src/services/purchaseBatchLocator.js |
| `purchase.group.thread.bind_failed` | 1 | src/services/purchaseBatchLocator.js |
| `purchase.group.thread.bound` | 1 | src/services/purchaseBatchLocator.js |
| `purchase.inbound.state_check.failed` | 1 | src/services/purchase/arrival.js |
| `purchase.request.created` | 1 | src/services/purchaseWebhookService.js |
| `purchase.request.image.attachment_exists` | 2 | src/services/purchase/documentImages.js |
| `purchase.request.image.attachment_write_failed` | 1 | src/services/purchase/documentImages.js |
| `purchase.request.image.attachment_written` | 1 | src/services/purchase/documentImages.js |
| `purchase.request.image.batch_mapping_failed` | 1 | src/services/purchase/documentImages.js |
| `purchase.request.image.delivery_failed` | 1 | src/services/purchase/documentImages.js |
| `purchase.request.image.delivery_persist_failed` | 1 | src/services/purchase/documentImages.js |
| `purchase.request.image.group_sent` | 1 | src/services/purchase/documentImages.js |
| `purchase.request.image.no_batch_no` | 1 | src/services/purchase/documentImages.js |
| `purchase.request.image.operator_missing` | 1 | src/services/purchase/documentImages.js |
| `purchase.request.image.prepare_failed` | 2 | src/services/purchase/documentImages.js<br>src/services/purchase/preparedImages.js |
| `purchase.request.image.prepared` | 1 | src/services/purchase/documentImages.js |
| `purchase.request.image.send_failed` | 1 | src/services/purchase/documentImages.js |
| `purchase.request.image.skipped` | 1 | src/services/purchase/documentImages.js |
| `purchase.request.image.thread_root_missing` | 1 | src/services/purchase/documentImages.js |
| `purchase.return.batch.record_ensured` | 2 | src/services/purchaseOrderBatchService.js |

## push

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `push.transient_retry.exhausted` | 2 | src/config/pushRetry.js |
| `push.transient_retry.skipped` | 2 | src/config/pushRetry.js |
| `push.transient_retry.waiting` | 2 | src/config/pushRetry.js |

## sales

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `sales.delivery.completed` | 1 | src/services/salesDeliveryService.js |
| `sales.delivery.inventory_batch_fallback` | 1 | src/services/salesDeliveryService.js |
| `sales.delivery.line.failed` | 1 | src/services/salesDeliveryService.js |
| `sales.detail_id.skipped` | 1 | src/services/salesOrderService.js |
| `sales.entry.total_amount.skipped` | 2 | src/services/sales/oneShotWrite.js<br>src/services/salesOrderService.js |
| `sales.entry.total_amount.written` | 2 | src/services/sales/oneShotWrite.js<br>src/services/salesOrderService.js |
| `sales.group.sale.located` | 2 | src/services/salesGroupThreadLocator.js |
| `sales.group.sale.unresolved` | 1 | src/services/salesGroupThreadLocator.js |
| `sales.group.thread.bind_failed` | 1 | src/services/salesGroupThreadLocator.js |
| `sales.group.thread.bound` | 1 | src/services/salesGroupThreadLocator.js |
| `sales.group.thread.remember_failed` | 1 | src/services/larkMvpService.js |
| `sales.group.thread.remembered` | 1 | src/services/salesGroupThreadLocator.js |
| `sales.inventory.applied` | 1 | src/services/salesDeliveryService.js |
| `sales.message_link.unavailable` | 1 | src/services/salesMessageLinkService.js |
| `sales.order_no.collision` | 1 | src/services/salesEntryService.js |
| `sales.order_no.generated` | 1 | src/services/salesEntryService.js |
| `sales.pending_deal_push.purchase_link.mapping_lookup_failed` | 1 | src/services/purchasePendingBatchService.js |
| `sales.pending_deal_push.purchase_link.unmapped` | 1 | src/services/purchasePendingBatchService.js |
| `sales.pending_deal_push.purchase_supplier_index_failed` | 1 | src/services/purchasePendingBatchService.js |
| `sales.read.retry` | 1 | src/services/salesReadRetry.js |
| `sales.second_delivery.completed` | 1 | src/services/secondDeliveryService.js |
| `sales.second_delivery.items.accessory_read_failed` | 1 | src/services/secondDeliveryService.js |
| `sales.second_delivery.items.incomplete` | 1 | src/services/secondDeliveryService.js |
| `sales.second_delivery.items.index_failed` | 1 | src/services/secondDeliveryService.js |
| `sales.second_delivery.reminder.order_skipped` | 3 | src/services/secondDeliveryService.js |
| `sales.status.write_failed` | 2 | src/services/salesStatusWriter.js |
| `sales.status.written` | 1 | src/services/salesStatusWriter.js |

## scan

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `scan.accept.duplicate` | 1 | src/config/scanWrite.js |
| `scan.accept.failed` | 1 | src/config/scanWrite.js |
| `scan.accept.finished` | 1 | src/config/scanWrite.js |
| `scan.accept.finishing` | 1 | src/config/scanWrite.js |
| `scan.accept.line_added` | 1 | src/config/scanWrite.js |
| `scan.accept.not_in_batch` | 1 | src/config/scanWrite.js |
| `scan.accept.pending_batches_failed` | 1 | src/services/scanArrivalService.js |
| `scan.accept.pending_cache.invalidate_failed` | 2 | src/services/purchase/arrival.js<br>src/services/scanArrivalService.js |
| `scan.accept.pending_filter_failed` | 1 | src/services/purchasePendingBatchService.js |
| `scan.accept.reused` | 1 | src/config/scanWrite.js |
| `scan.accept.rows_set` | 1 | src/config/scanWrite.js |
| `scan.accept.started` | 1 | src/config/scanWrite.js |
| `scan.accept.timing` | 1 | src/config/scanWrite.js |
| `scan.data.filter_fallback` | 1 | src/config/scanPage.js |
| `scan.data.filtered_empty` | 1 | src/config/scanPage.js |
| `scan.data.limit_exceeded` | 1 | src/config/scanPage.js |
| `scan.entry.keep_draft_clear_failed` | 1 | src/routes/scanPage/flowHelpers.js |
| `scan.label_print.enqueued` | 1 | src/routes/scanPage/handlers/smallActions.js |
| `scan.label_print.failed` | 1 | src/routes/scanPage/handlers/smallActions.js |
| `scan.label_print.number_unresolved` | 1 | src/routes/scanPage/handlers/smallActions.js |
| `scan.label_print.ready_failed` | 1 | src/routes/scanPage/flowHelpers.js |
| `scan.launch` | 1 | src/utils/uiTapReport.js |
| `scan.lookup.timing` | 1 | src/config/scanPage.js |
| `scan.multi_item.add` | 1 | src/config/multiItemOrder.js |
| `scan.multi_item.render` | 1 | src/config/multiItemOrder.js |
| `scan.page.bad_number` | 1 | src/config/scanPage.js |
| `scan.page.cache_hit` | 1 | src/config/scanPage.js |
| `scan.page.cache_miss` | 1 | src/config/scanPage.js |
| `scan.page.failed` | 1 | src/config/scanPage.js |
| `scan.page.login_redirect` | 1 | src/config/scanAuthRedirect.js |
| `scan.page.not_found` | 1 | src/config/scanPage.js |
| `scan.page.record_fallback` | 1 | src/config/scanPage.js |
| `scan.page.record_lookup_failed` | 1 | src/config/scanPage.js |
| `scan.page.record_missing` | 1 | src/config/scanPage.js |
| `scan.page.record_viewed` | 1 | src/config/scanPage.js |
| `scan.page.rendered` | 1 | src/config/scanPage.js |
| `scan.page.viewed` | 1 | src/config/scanPage.js |
| `scan.payment_step.reset_failed` | 1 | src/config/scanPage.js |
| `scan.payment_step.reset_on_scan` | 1 | src/config/scanPage.js |
| `scan.payment_step.stale_clear_failed` | 1 | src/routes/scanPage/index.js |
| `scan.payment_step.stale_cleared` | 1 | src/routes/scanPage/index.js |
| `scan.purchase_return.batch_created` | 1 | src/config/scanWrite.js |
| `scan.purchase_return.image_failed` | 1 | src/config/scanWrite.js |
| `scan.purchase_return.plan_frozen` | 1 | src/config/scanWrite.js |
| `scan.purchase_return.reused` | 1 | src/config/scanWrite.js |
| `scan.purchase_return.shortfall` | 1 | src/config/scanWrite.js |
| `scan.purchase_return.stock_applied` | 1 | src/config/scanWrite.js |
| `scan.purchase_return.submitted` | 1 | src/config/scanWrite.js |
| `scan.purchase_return.submitting` | 1 | src/config/scanWrite.js |
| `scan.purchase.background_failed` | 3 | src/config/alerts.js<br>src/config/scanWrite.js |
| `scan.purchase.background_mark_failed` | 3 | src/config/alerts.js<br>src/config/scanWrite.js |
| `scan.purchase.background.timing` | 2 | src/config/alerts.js<br>src/config/scanWrite.js |
| `scan.purchase.regenerated` | 1 | src/config/scanWrite.js |
| `scan.purchase.reused` | 1 | src/config/scanWrite.js |
| `scan.purchase.submitted` | 1 | src/config/scanWrite.js |
| `scan.purchase.submitting` | 1 | src/config/scanWrite.js |
| `scan.realm_scan.report` | 1 | src/routes/scanPage/index.js |
| `scan.realm_scan.signature_failed` | 1 | src/routes/scanPage/index.js |
| `scan.realm_scan.signature_ok` | 1 | src/routes/scanPage/index.js |
| `scan.sale.amount_mismatch` | 1 | src/config/scanWrite.js |
| `scan.sale.async.done` | 1 | src/services/salesAsyncWorker.js |
| `scan.sale.async.enqueue_failed` | 3 | src/config/alerts.js<br>src/routes/scanPage/handlers/payment.js |
| `scan.sale.async.enqueued` | 1 | src/routes/scanPage/handlers/payment.js |
| `scan.sale.async.failed` | 4 | src/config/alerts.js<br>src/services/salesAsyncWorker.js |
| `scan.sale.async.invalid_payload` | 1 | src/routes/scanPage/handlers/payment.js |
| `scan.sale.async.queue_failed` | 1 | src/services/salesAsyncWorker.js |
| `scan.sale.async.queued` | 1 | src/services/salesAsyncWorker.js |
| `scan.sale.async.start_failed` | 3 | src/config/alerts.js<br>src/services/salesAsyncRuntime.js |
| `scan.sale.background_done` | 1 | src/config/scanWrite.js |
| `scan.sale.background_failed` | 3 | src/config/alerts.js<br>src/config/scanWrite.js |
| `scan.sale.background_queued` | 1 | src/config/scanWrite.js |
| `scan.sale.draft_cleared` | 1 | src/config/scanWrite.js |
| `scan.sale.interrupted_cleared` | 1 | src/config/scanWrite.js |
| `scan.sale.interrupted_detected` | 2 | src/config/scanWrite.js<br>src/services/scanSessionService.js |
| `scan.sale.line_added` | 1 | src/config/scanWrite.js |
| `scan.sale.order_no.allocate_failed` | 3 | src/config/alerts.js<br>src/routes/scanPage/handlers/salesSubmit.js |
| `scan.sale.partial_failed` | 1 | src/config/scanWrite.js |
| `scan.sale.payment` | 1 | src/config/timing.js |
| `scan.sale.payment_methods_unreadable` | 2 | src/config/voucherPayment.js<br>src/routes/scanPage/index.js |
| `scan.sale.reused` | 1 | src/config/scanWrite.js |
| `scan.sale.stock_failed` | 1 | src/config/scanWrite.js |
| `scan.sale.submit` | 1 | src/config/timing.js |
| `scan.sale.submitted` | 1 | src/config/scanWrite.js |
| `scan.sale.submitting` | 1 | src/config/scanWrite.js |
| `scan.sale.timing` | 2 | src/config/alerts.js<br>src/config/scanWrite.js |
| `scan.sales_home.opened` | 1 | src/config/scanPage.js |
| `scan.session.expired` | 1 | src/config/scanWrite.js |
| `scan.session.stale_draft_dropped` | 1 | src/services/scanSessionService.js |
| `scan.session.started` | 1 | src/config/scanWrite.js |
| `scan.size_consistency.mismatch` | 1 | src/config/scanPage.js |
| `scan.size.unresolved` | 1 | src/config/scanPage.js |
| `scan.sizes.scope_unavailable` | 1 | src/config/scanPage.js |
| `scan.snapshot.invalidated` | 1 | src/config/scanPage.js |
| `scan.snapshot.miss` | 1 | src/config/scanPage.js |
| `scan.snapshot.refresh_failed` | 1 | src/config/scanPage.js |
| `scan.snapshot.refreshed` | 1 | src/config/scanPage.js |
| `scan.snapshot.warm.done` | 1 | src/app.js |
| `scan.snapshot.warm.skipped` | 1 | src/app.js |
| `scan.state.unexpected` | 1 | src/config/scanPage.js |
| `scan.write.action_inferred` | 1 | src/routes/scanPage/index.js |
| `scan.write.disabled` | 1 | src/config/scanWrite.js |
| `scan.write.failed` | 2 | src/config/alerts.js<br>src/config/scanWrite.js |
| `scan.write.jump_gate_blocked` | 1 | src/routes/scanPage/handlers/salesSubmit.js |
| `scan.write.line_amount_required` | 1 | src/routes/scanPage/handlers/salesSubmit.js |
| `scan.write.payment_amount_required` | 1 | src/config/scanWrite.js |
| `scan.write.purchase_amount_required` | 1 | src/config/scanWrite.js |
| `scan.write.purchase_entry_invalid` | 1 | src/config/scanWrite.js |
| `scan.write.settlement_blocked` | 1 | src/routes/scanPage/handlers/payment.js |
| `scan.write.unknown_action` | 1 | src/config/scanWrite.js |
| `scan.write.voucher_blocked` | 1 | src/routes/scanPage/handlers/payment.js |
| `scan.write.voucher_catalog_unreadable` | 1 | src/config/voucherPayment.js |
| `scan.write.voucher_method_unmapped` | 1 | src/config/voucherPayment.js |
| `scan.write.voucher_resolved` | 1 | src/routes/scanPage/handlers/payment.js |

## server

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `server.started` | 1 | src/app.js |

## supplier

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `supplier.split.group_already_reported` | 1 | src/config/supplierSplit.js |
| `supplier.split.grouped` | 1 | src/config/supplierSplit.js |
| `supplier.split.mismatch` | 1 | src/config/supplierSplit.js |

## ui

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `ui.action` | 1 | src/utils/uiTapReport.js |
| `ui.page.view` | 1 | src/config/funnel.js |
| `ui.step.enter` | 1 | src/config/funnel.js |
| `ui.tap.repeated` | 1 | src/config/uiTap.js |
| `ui.tap.result` | 1 | src/config/uiTap.js |

## v1

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `v1.sale.goods_posted` | 1 | src/services/salesOrderService.js |
| `v1.sale.posted` | 2 | src/services/sales/oneShotWrite.js<br>src/services/salesOrderService.js |

## workbench

| 事件 | 次数 | 文件 |
| --- | --- | --- |
| `workbench.auth.failed` | 1 | src/routes/feishuWebAuth.js |
| `workbench.auth.provider_error` | 1 | src/routes/feishuWebAuth.js |
| `workbench.auth.success` | 1 | src/routes/feishuWebAuth.js |
| `workbench.inventory.categories_failed.cache_hit` | 1 | src/controllers/workbenchController.js |
| `workbench.inventory.categories_failed.cache_miss` | 1 | src/controllers/workbenchController.js |
| `workbench.inventory.products_failed.cache_hit` | 1 | src/controllers/workbenchController.js |
| `workbench.inventory.products_failed.cache_miss` | 1 | src/controllers/workbenchController.js |
| `workbench.inventory.query_failed.cache_hit` | 1 | src/controllers/workbenchController.js |
| `workbench.inventory.query_failed.cache_miss` | 1 | src/controllers/workbenchController.js |
| `workbench.inventory.stock_failed.cache_hit` | 1 | src/controllers/workbenchController.js |
| `workbench.inventory.stock_failed.cache_miss` | 1 | src/controllers/workbenchController.js |
| `workbench.label_print.scan.rejected` | 1 | src/routes/labelPrintQueue.js |
| `workbench.labels.cache_hit` | 1 | src/services/labelPrintService.js |
| `workbench.labels.cache_miss` | 1 | src/services/labelPrintService.js |
| `workbench.labels.failed.cache_hit` | 1 | src/routes/workbench/labels.js |
| `workbench.labels.failed.cache_miss` | 1 | src/routes/workbench/labels.js |
| `workbench.labels.listed` | 1 | src/services/labelPrintService.js |
| `workbench.labels.missing_price` | 1 | src/services/labelPrintService.js |
| `workbench.labels.missing_qr_record_id` | 1 | src/services/labelPrintService.js |
| `workbench.labels.product_created_time_renamed` | 1 | src/services/labelPrintService.js |
| `workbench.labels.product_created_time_resolved` | 1 | src/services/labelPrintService.js |
| `workbench.labels.product_created_time_unresolved` | 2 | src/services/labelPrintService.js |
| `workbench.labels.record_read_failed` | 1 | src/services/labelPrintService.js |
| `workbench.labels.record_resolved` | 1 | src/services/labelPrintService.js |
| `workbench.labels.skipped_records` | 1 | src/services/labelPrintService.js |
| `workbench.labels.without_stock_missing_created_at` | 1 | src/services/labelPrintService.js |
| `workbench.labels.without_stock_skipped` | 1 | src/services/labelPrintService.js |
| `workbench.lark.jsapi_signature.error` | 1 | src/routes/workbench.js |
| `workbench.lark.jsapi_signature.failed` | 1 | src/routes/workbench.js |
| `workbench.lark.jsapi_signature.ok` | 1 | src/routes/workbench.js |
| `workbench.orders.after_sales.completed` | 1 | src/services/workbenchOrderActionService.js |
| `workbench.orders.second_delivery.completed` | 1 | src/services/workbenchOrderActionService.js |
| `workbench.procurement.new_products.failed` | 1 | src/routes/workbench/purchase.js |
| `workbench.procurement.replenish.failed` | 1 | src/routes/workbench/purchase.js |
| `workbench.procurement.submit.failed` | 1 | src/routes/workbench/purchase.js |
| `workbench.products.numbers.cache_hit` | 1 | src/services/labelPrintService.js |
| `workbench.products.numbers.cache_miss` | 1 | src/services/labelPrintService.js |
| `workbench.products.numbers.failed.cache_hit` | 1 | src/routes/workbench/labels.js |
| `workbench.products.numbers.failed.cache_miss` | 1 | src/routes/workbench/labels.js |
| `workbench.products.numbers.filtered` | 2 | src/services/labelPrintService.js |
| `workbench.products.numbers.listed` | 1 | src/services/labelPrintService.js |
| `workbench.products.numbers.server_filter_off` | 1 | src/services/labelPrintService.js |
| `workbench.products.numbers.stock_read_failed` | 1 | src/services/labelPrintService.js |
| `workbench.purchase.arrival_accept.failed` | 1 | src/routes/workbench/purchase.js |
| `workbench.purchase.arrival_confirm.failed` | 1 | src/routes/workbench/purchase.js |
| `workbench.purchase.arrival_confirm.rejected` | 1 | src/services/workbenchPurchaseArrivalService.js |
| `workbench.purchase.arrival_detail.failed` | 1 | src/routes/workbench/purchase.js |
| `workbench.purchase.arrivals.failed` | 1 | src/routes/purchaseQuery.js |
| `workbench.purchase.requests.failed` | 1 | src/routes/purchaseQuery.js |
| `workbench.query.retry` | 1 | src/services/v1WorkbenchService.js |
| `workbench.sales.after_sales.candidates.failed` | 2 | src/routes/workbench/sales.js<br>src/routes/workbenchOrderActions.js |
| `workbench.sales.delivery.failed` | 3 | src/routes/workbenchSalesDelivery.js<br>src/services/salesDeliveryAsyncService.js |
| `workbench.sales.delivery.job_enqueued` | 1 | src/services/salesDeliveryAsyncService.js |
| `workbench.sales.delivery.job_finished` | 2 | src/services/salesDeliveryAsyncService.js |
| `workbench.sales.delivery.job_started` | 1 | src/services/salesDeliveryAsyncService.js |
| `workbench.sales.delivery.read_timing` | 1 | src/services/salesDeliveryReadService.js |
| `workbench.sales.orders.failed` | 2 | src/routes/workbench/sales.js<br>src/routes/workbenchSalesDelivery.js |
| `workbench.sales.orders.order_skipped` | 1 | src/services/salesFollowupService.js |
| `workbench.sales.orders.read_retry` | 2 | src/services/salesDeliveryReadService.js<br>src/services/salesFollowupService.js |
| `workbench.sales.payment.failed` | 2 | src/routes/workbenchSalesDelivery.js<br>src/services/salesDeliveryPaymentService.js |
| `workbench.sales.sample_fill.applied` | 1 | src/services/samplePendingService.js |
| `workbench.sales.sample_fill.no_doorbox` | 1 | src/services/samplePendingService.js |
| `workbench.sales.sample_fill.reused` | 1 | src/services/samplePendingService.js |
| `workbench.sales.sample_notice.failed` | 1 | src/routes/workbenchSalesDelivery.js |
| `workbench.sales.sample_pending.candidates_unreadable` | 1 | src/services/salesFollowupService.js |
| `workbench.sales.sample_pending.live_snapshot_unreadable` | 1 | src/services/salesFollowupService.js |
| `workbench.sales.sample_pending.tasks_unreadable` | 1 | src/services/salesFollowupService.js |
| `workbench.size.unresolved` | 1 | src/services/v1WorkbenchService.js |
