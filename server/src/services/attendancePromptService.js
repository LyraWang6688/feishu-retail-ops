'use strict';

const { ROLES } = require('../config/permissions');
const { SHANGHAI_OFFSET_MS } = require('../utils/shanghaiDay');

/** 上海小时（0–23）；与 shanghaiDailyScheduler 同一套 +8 算法。 */
const shanghaiHour = (epoch) => new Date(Number(epoch) + SHANGHAI_OFFSET_MS).getUTCHours();

/**
 * 纯判定：不读库、不写库。
 * @param {{actor: object, staff: object[], clockedInIds: Set<string>, now: number, date: string, config: object}} input
 * @returns {{date: string, afterHour: boolean, self: object, managed: object[]}}
 */
const evaluateAttendancePrompt = ({ actor, staff, clockedInIds, now, date, config }) => {
  const afterHour = shanghaiHour(now) >= config.hour;
  const active = Boolean(config.enabled) && afterHour;
  const byId = clockedInIds instanceof Set ? clockedInIds : new Set(clockedInIds || []);
  const selfClocked = byId.has(actor.recordId);
  const self = {
    recordId: actor.recordId,
    name: actor.name,
    clockedIn: selfClocked,
    shouldPrompt: Boolean(active && actor.active && actor.attend && !selfClocked),
  };
  const roleNames = Array.isArray(actor.roleNames) ? actor.roleNames : [];
  const isAttendanceTaker = Boolean(actor.active) && roleNames.includes(ROLES.ATTENDANCE);
  const managed = active && isAttendanceTaker
    ? (staff || [])
      .filter((person) => person.active && person.attend
        && person.recordId !== actor.recordId
        && !byId.has(person.recordId))
      .map((person) => ({ recordId: person.recordId, name: person.name }))
    : [];
  return { date, afterHour, self, managed };
};

module.exports = { evaluateAttendancePrompt, shanghaiHour };
