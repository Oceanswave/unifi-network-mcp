import { z } from "zod";
import type { NetworkClient } from "../client.js";

/**
 * Hard refusals for writes that would let traffic in from the WAN. Unlike
 * confirm, which the model can pass after asking (or after being talked into
 * it by data it read), these hold whatever the call says: the operator turns
 * them off with UNIFI_NETWORK_ALLOW_WAN_EXPOSURE=true, and then the existing
 * confirm flow applies.
 *
 * Which zone is the WAN: the Integration API marks zones only with
 * metadata.origin, and names can be changed, so a zone is the WAN when its ID
 * is in UNIFI_NETWORK_WAN_ZONE_IDS, or when it is system-defined and named
 * "External". The ID list is the reliable signal; the name is the fallback
 * for operators who have not set it. When the zones cannot be read, or a
 * zone a change depends on is not among them, the write is refused: a check
 * that cannot run must not pass.
 *
 * ACL rules need no check: they are switch-enforced IPV4/MAC rules between
 * LAN hosts and have no zone, so they cannot admit WAN traffic past the
 * gateway firewall. The Integration API has no port-forward endpoint.
 */

export interface WanPolicy {
  /** UNIFI_NETWORK_ALLOW_WAN_EXPOSURE: skip these refusals. */
  allowExposure: boolean;
  /** UNIFI_NETWORK_WAN_ZONE_IDS, lower-cased. */
  zoneIds: readonly string[];
}

export const DEFAULT_WAN_POLICY: WanPolicy = { allowExposure: false, zoneIds: [] };

const Zone = z.object({
  id: z.string(),
  name: z.string().optional(),
  networkIds: z.array(z.string()).optional(),
  metadata: z.object({ origin: z.string().optional() }).loose().optional(),
}).loose();
type Zone = z.infer<typeof Zone>;

const Policy = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  action: z.unknown().optional(),
  source: z.unknown().optional(),
}).loose();

const PAGE_LIMIT = 200;
const MAX_PAGES = 50;

async function listAll<T extends z.ZodType>(client: NetworkClient, path: string, item: T): Promise<z.infer<T>[]> {
  const page = z.object({ data: z.array(item), totalCount: z.number().optional() }).loose();
  const items: z.infer<T>[] = [];
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const { data, totalCount } = page.parse(await client.get(`${path}?offset=${items.length}&limit=${PAGE_LIMIT}`));
    items.push(...data);
    // Without a totalCount, only a short page shows the list has ended.
    if (data.length === 0 || (totalCount === undefined ? data.length < PAGE_LIMIT : items.length >= totalCount)) return items;
  }
  throw new Error(`more than ${MAX_PAGES * PAGE_LIMIT} entries`);
}

class Refusal extends Error {}

/** The checks for one site; zones are read at most once per call. */
export class WanExposure {
  private zones?: Promise<Zone[]>;

  constructor(
    private readonly client: NetworkClient,
    private readonly wan: WanPolicy,
    private readonly siteId: string
  ) {}

  /** A firewall policy, as it would be after the write: refused if it ALLOWs traffic from the WAN. */
  async firewallPolicy(policy: Record<string, unknown>): Promise<string | undefined> {
    if (this.wan.allowExposure || !allowsTraffic(policy)) return undefined;
    return this.refusal(async () => {
      const zoneId = sourceZoneId(policy);
      if (zoneId === undefined) {
        throw new Refusal("the policy ALLOWs traffic but has no source.zoneId, so its source cannot be checked against the WAN zone");
      }
      const zone = await this.zone(zoneId, "its source zone");
      if (this.isWan(zone)) throw new Refusal(`the policy would ALLOW traffic from the ${label(zone)} zone, which is the WAN`);
    });
  }

  /** A zone create (zoneId undefined) or full update: refused if it changes the WAN zone or takes networks from it. */
  async firewallZone(zoneId: string | undefined, networkIds: readonly string[]): Promise<string | undefined> {
    if (this.wan.allowExposure || (zoneId === undefined && networkIds.length === 0)) return undefined;
    return this.refusal(async () => {
      if (zoneId !== undefined) {
        const zone = await this.zone(zoneId, "the zone");
        if (this.isWan(zone)) throw new Refusal(`the change would modify the ${label(zone)} zone, which is the WAN`);
      }
      const wanNetworks = new Set((await this.zoneList()).filter((zone) => this.isWan(zone))
        .flatMap((zone) => zone.networkIds ?? []).map((id) => id.toLowerCase()));
      const moved = networkIds.filter((id) => wanNetworks.has(id.toLowerCase()));
      if (moved.length > 0) throw new Refusal(`the change would move networks out of the WAN zone: ${moved.join(", ")}`);
    });
  }

  /** The zone a network is put in: refused if it is the WAN zone. */
  async networkZone(zoneId: string): Promise<string | undefined> {
    if (this.wan.allowExposure) return undefined;
    return this.refusal(async () => {
      const zone = await this.zone(zoneId, "the network's zoneId");
      if (this.isWan(zone)) throw new Refusal(`the change would put the network in the ${label(zone)} zone, which is the WAN`);
    });
  }

  /** A policy reorder: refused for policies that apply to traffic from the WAN. */
  async policyOrder(sourceZoneId: string): Promise<string | undefined> {
    if (this.wan.allowExposure) return undefined;
    return this.refusal(async () => {
      const zone = await this.zone(sourceZoneId, "the source zone");
      if (this.isWan(zone)) {
        throw new Refusal(`the change would reorder the policies for traffic from the ${label(zone)} zone, which is the WAN, and could put an ALLOW ahead of a BLOCK`);
      }
    });
  }

  /** A traffic matching list update: refused if a policy that ALLOWs traffic from the WAN uses the list. */
  async matchingList(listId: string): Promise<string | undefined> {
    if (this.wan.allowExposure) return undefined;
    return this.refusal(async () => {
      const zones = await this.zoneList();
      let policies;
      try {
        policies = await listAll(this.client, `/sites/${this.siteId}/firewall/policies`, Policy);
      } catch (err) {
        throw new Refusal(`the firewall policies that might use the list could not be read (${message(err)})`);
      }
      const user = policies.find((policy) => {
        // IDs are compared without case: the controller may not care about it.
        if (!allowsTraffic(policy) || !JSON.stringify(policy).toLowerCase().includes(JSON.stringify(listId.toLowerCase()))) return false;
        // A source zone that is not on the list could be the WAN: count it.
        const zone = zones.find((candidate) => candidate.id === sourceZoneId(policy));
        return zone === undefined || this.isWan(zone);
      });
      if (user) {
        throw new Refusal(`the list is used by firewall policy ${JSON.stringify(user.name ?? user.id)}, which ALLOWs traffic from the WAN, so changing it changes what the WAN can reach`);
      }
    });
  }

  private isWan(zone: Zone): boolean {
    return this.wan.zoneIds.includes(zone.id.toLowerCase()) ||
      (zone.metadata?.origin === "SYSTEM_DEFINED" && zone.name?.toLowerCase() === "external");
  }

  private async zone(zoneId: string, what: string): Promise<Zone> {
    const zone = (await this.zoneList()).find((candidate) => candidate.id === zoneId);
    if (zone === undefined) throw new Refusal(`${what} (${zoneId}) is not one of this site's firewall zones, so it cannot be checked against the WAN zone`);
    return zone;
  }

  private zoneList(): Promise<Zone[]> {
    this.zones ??= listAll(this.client, `/sites/${this.siteId}/firewall/zones`, Zone).catch((err: unknown) => {
      throw new Refusal(`the firewall zones could not be read to find the WAN zone (${message(err)})`);
    });
    return this.zones;
  }

  private async refusal(check: () => Promise<void>): Promise<string | undefined> {
    try {
      await check();
      return undefined;
    } catch (err) {
      if (err instanceof Refusal) return err.message;
      return `the WAN check failed (${message(err)})`;
    }
  }
}

/** Any action but BLOCK or REJECT lets traffic through, including a missing one. */
function allowsTraffic(policy: Record<string, unknown>): boolean {
  const action = policy.action;
  const type = action !== null && typeof action === "object" && "type" in action ? action.type : undefined;
  return type !== "BLOCK" && type !== "REJECT";
}

function sourceZoneId(policy: Record<string, unknown>): string | undefined {
  const source = policy.source;
  const zoneId = source !== null && typeof source === "object" && "zoneId" in source ? source.zoneId : undefined;
  return typeof zoneId === "string" ? zoneId : undefined;
}

function label(zone: Zone): string {
  return zone.name ?? zone.id;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The result of a refused write. */
export function wanRefusal(reason: string) {
  return {
    content: [{
      type: "text" as const,
      text: `Refused: ${reason}. This server does not make changes that could let traffic in from the WAN, and confirm does not override this; if the change is intended, make it in the UniFi console.`,
    }],
    isError: true as const,
  };
}
