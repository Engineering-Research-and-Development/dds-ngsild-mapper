'use strict';

const { cleanName } = require('./mapping');

/**
 * Initial mapping suggestions for a discovered DDS entry.
 *
 * The web frontend pre-fills its inputs with these values; the operator stays
 * free to override any of them. Suggestions are derived from the ROS 2 type so
 * they are more meaningful than the flat CLI defaults (entityType "DDS",
 * entityId "urn:ngsi-ld:dds:default").
 *
 *   topic   rt/cmd_vel  (geometry_msgs/msg/Twist)
 *     → entityType "Twist", attribute "cmd_vel", entityId "urn:ngsi-ld:Twist:cmd_vel"
 *   service set_bool    (std_srvs/srv/SetBool_Request)
 *     → entityType "SetBool"
 *   action  navigate_to_pose (nav2_msgs/action/NavigateToPose_SendGoal_Request)
 *     → entityType "NavigateToPose"
 */

/** Last path segment of a ROS type, stripped of service/action role suffixes. */
function typeLeaf(typeName) {
  if (!typeName) return '';
  const leaf = String(typeName).split('/').pop() || '';
  return leaf
    .replace(/_(SendGoal|GetResult)_(Request|Response)$/i, '') // action sub-services
    .replace(/_(Request|Response)$/i, '')                      // service req/rep
    .replace(/_(FeedbackMessage|Feedback|Goal|Result)$/i, ''); // action messages
}

/** PascalCase a cleaned name, e.g. "battery_state" → "BatteryState". */
function pascal(name) {
  return String(name)
    .split(/[_.\-\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function suggestEntityType(kind, item) {
  let leaf = '';
  if (kind === 'topic')   leaf = typeLeaf(item.typeName);
  if (kind === 'service') leaf = typeLeaf(item.requestType);
  if (kind === 'action')  leaf = typeLeaf(item.goalType);
  return leaf || pascal(cleanName(item.name)) || 'DDS';
}

function suggestAttribute(item) {
  return cleanName(item.name);
}

function suggestEntityId(entityType, item) {
  const local    = cleanName(item.name);
  const typePart = String(entityType || 'DDS').replace(/[^a-zA-Z0-9._~-]/g, '');
  return `urn:ngsi-ld:${typePart}:${local}`;
}

/** Full suggestion bundle for one discovered entry. */
function suggestRow(kind, item) {
  const entityType = suggestEntityType(kind, item);
  return {
    entityType,
    attribute: suggestAttribute(item),
    entityId:  suggestEntityId(entityType, item),
  };
}

module.exports = {
  suggestRow,
  suggestEntityType,
  suggestAttribute,
  suggestEntityId,
  typeLeaf,
  pascal,
};
