import { useQuery } from "@tanstack/react-query";
import type { GammaEvent } from "../types/gamma-api";

/**
 * GAMMA API utils.
 * - Fetch nfl games
 * - parse associated markets
 */

const byStartTime = (a: GammaEvent, b: GammaEvent) => {
  return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
};

const getNflGames = async () => {
  const games = new Map<string, GammaEvent>();
  const slugRe = /^nfl-[a-z]{2,4}-[a-z]{2,4}-\d{4}-\d{2}-\d{2}$/;

  // fetch "indefinitely" by 100 until total event count is < 100
  for (let offset = 0; ; offset += 100) {
    const params = new URLSearchParams({
      tag_slug: "nfl",
      active: "true",
      closed: "false",
      limit: "100",
      offset: String(offset),
    });

    const res = await fetch(
      `https://gamma-api.polymarket.com/events?${params.toString()}`,
    );

    if (!res.ok) {
      throw new Error(
        `Failed to fetch events from gamma-api: ${res.statusText}`,
      );
    }

    const data = await res.json();

    for (const ev of data) {
      // only add an event to our games map if it matches the provided regex
      if (slugRe.test(ev.slug)) {
        games.set(ev.slug, ev);
      }
    }

    // if total event count is < 100 (our page size limit) then there are no more pages after this one
    if (data.length < 100) break;
  }

  // sort the games by start time
  console.log(games.values());
  return [...games.values()].sort(byStartTime);
};

export const useGetNflGames = () => {
  // react query to make life a bit easier :)
  return useQuery({
    queryKey: ["nflGames"],
    queryFn: getNflGames,
    // not adding any stale time/refetch mechanisms at this point
  });
};

const parseStringArray = (str: string[] | string): string[] => {
  const parsed = typeof str === "string" ? JSON.parse(str) : str;
  return Array.isArray(parsed) ? parsed : [];
};

export const getMarketsForGame = (gameEv: GammaEvent | null) => {
  if (!gameEv) return [];
  // AI used to generate regex based on "{event.title}: O/U {number}"
  // MODEL: GPT-5.6 SOL
  const totalPrefix = `${gameEv.title}: O/U `;
  const totalRegex = /^\d+(?:\.\d+)?$/;

  const filteredMarkets = gameEv.markets.filter(
    (m) =>
      m.question === gameEv.title ||
      // check if question starts with `title: O/U `
      (m.question.startsWith(totalPrefix) &&
        // AND if total outcome is a number with no suffix
        totalRegex.test(m.question.slice(totalPrefix.length))),
  );

  return filteredMarkets.flatMap((m) => {
    const totalLineText = m.question.slice(totalPrefix.length);

    const outcomes = parseStringArray(m.outcomes);
    const tokenIds = parseStringArray(m.clobTokenIds);

    // each market should have exactly 2 outcomes, thus 2 'subscription ids'. exit if that is not the case, either we did something wrong or data provided is incorrect
    if (outcomes.length !== 2 || tokenIds.length !== 2) {
      return [];
    }

    return outcomes.map((o, idx) => ({
      question: m.question,
      outcome: o,
      clobTokenId: tokenIds[idx],
      type: m.question === gameEv.title ? "moneyline" : "total",
      totalLine: totalRegex.test(totalLineText) ? Number(totalLineText) : null,
    }));
  });
};
