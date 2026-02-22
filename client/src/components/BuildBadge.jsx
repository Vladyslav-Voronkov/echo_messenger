/* global __BUILD__ */
export default function BuildBadge() {
  const build = typeof __BUILD__ !== 'undefined' ? __BUILD__ : 'dev';
  return (
    <div className="build-badge" title={`Сборка: ${build}`}>
      build {build}
    </div>
  );
}
