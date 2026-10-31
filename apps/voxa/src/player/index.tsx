import { useEffect, useRef } from 'react';
import { getQueryValue } from '../utils/url';
import { Player } from './model';
import styles from './style.module.scss';

export default function PlayerView() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const player = useRef<Player | undefined>(undefined);

  useEffect(() => {
    if (!canvas.current) {
      return;
    }

    const newPlayer = new Player();

    player.current = newPlayer;

    newPlayer.init({ canvas: canvas.current }).then(() => {
      const modelFileHash = getQueryValue(
        window.location.href,
        'modelFileHash',
      );
      const modelIdStr = getQueryValue(window.location.href, 'modelId');

      const modelId = modelIdStr ? Number(modelIdStr) : undefined;

      const autoRotate =
        getQueryValue(window.location.href, 'autoRotate') === 'true';

      newPlayer.load({
        modelId,
        modelFileHash,
        autoRotate,
      });
    });

    return () => {
      player.current?.destroy();
    };
  }, []);

  return (
    <div className={styles.container}>
      <canvas className={styles.canvas} ref={canvas} />
    </div>
  );
}
