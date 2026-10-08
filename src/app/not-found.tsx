import Link from "next/link";

export default function NotFound() {
  return (
    <div className="form">
      <div className="p">
        <h1>Not found</h1>
        <p className="sub mute">That coin doesn&apos;t exist here.</p>
        <Link href="/" className="mbtn buy">
          Back to live coins
        </Link>
      </div>
    </div>
  );
}
