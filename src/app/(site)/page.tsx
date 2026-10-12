import { HomeView } from "@/components/home/HomeView";
import { predictionsEnabled } from "@/server/predictions/flag";

export default function Home() {
  return <HomeView predictions={predictionsEnabled()} />;
}
