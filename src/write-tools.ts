/**
 * Every write tool, grouped by the module in src/tools/ that registers it.
 * UNIFI_NETWORK_WRITE_TOOLS names tools or groups from here, and
 * registerAllTools() refuses to register a write tool that is missing, so the
 * list cannot fall behind the code.
 */
export const WRITE_TOOL_GROUPS = {
  devices: ["unifi_adopt_device", "unifi_remove_device", "unifi_restart_device", "unifi_power_cycle_port"],
  clients: ["unifi_authorize_guest", "unifi_unauthorize_guest"],
  networks: ["unifi_create_network", "unifi_update_network", "unifi_delete_network"],
  wifi: ["unifi_create_wifi", "unifi_update_wifi", "unifi_delete_wifi"],
  hotspot: ["unifi_create_voucher", "unifi_delete_voucher", "unifi_bulk_delete_vouchers"],
  firewall: [
    "unifi_create_firewall_zone", "unifi_update_firewall_zone", "unifi_delete_firewall_zone",
    "unifi_create_firewall_policy", "unifi_update_firewall_policy", "unifi_patch_firewall_policy",
    "unifi_delete_firewall_policy", "unifi_reorder_firewall_policies",
  ],
  acl: ["unifi_create_acl_rule", "unifi_update_acl_rule", "unifi_delete_acl_rule", "unifi_reorder_acl_rules"],
  "dns-policies": ["unifi_create_dns_policy", "unifi_update_dns_policy", "unifi_delete_dns_policy"],
  "traffic-matching": [
    "unifi_create_traffic_matching_list", "unifi_update_traffic_matching_list", "unifi_delete_traffic_matching_list",
  ],
} as const satisfies Record<string, readonly string[]>;

export const WRITE_TOOLS: readonly string[] = Object.values(WRITE_TOOL_GROUPS).flat();

const GROUPS: Record<string, readonly string[]> = WRITE_TOOL_GROUPS;

/**
 * The write tools a UNIFI_NETWORK_WRITE_TOOLS value enables, in catalog
 * order: a comma-separated list of tool and group names, or "" / "none" for
 * none. Names that are neither come back in unknown.
 */
export function parseWriteTools(value: string): { tools: string[]; unknown: string[] } {
  const names = value.split(",").map((name) => name.trim()).filter((name) => name !== "");
  if (names.length === 1 && names[0].toLowerCase() === "none") return { tools: [], unknown: [] };
  const enabled = new Set<string>();
  const unknown: string[] = [];
  for (const name of names) {
    const tools = Object.hasOwn(GROUPS, name) ? GROUPS[name] : WRITE_TOOLS.includes(name) ? [name] : undefined;
    if (tools === undefined) unknown.push(name);
    else for (const tool of tools) enabled.add(tool);
  }
  return { tools: WRITE_TOOLS.filter((tool) => enabled.has(tool)), unknown };
}
