"use client";
/** The top bar's coin search, shared with the home board (which filters by it on the client). */
import { createContext, useContext, useMemo, useState } from "react";

const SearchContext = createContext<{ query: string; setQuery: (query: string) => void }>({ query: "", setQuery: () => {} });

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [query, setQuery] = useState("");
  const value = useMemo(() => ({ query, setQuery }), [query]);
  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}

export const useSearch = () => useContext(SearchContext);
