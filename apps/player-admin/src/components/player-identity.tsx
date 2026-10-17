import { Avatar } from 'antd';

import type { Player } from '../player-admin-types';

export function PlayerIdentity({ player }:{ player:Pick<Player, 'displayName' | 'username'> }) {
    const name = player.displayName || player.username;
    return (
        <div className="player-admin-player">
            <Avatar>{name.slice(0, 1)}</Avatar>
            <span>
                <div className="player-admin-player-name">{name}</div>
                <div className="player-admin-player-meta">@{player.username}</div>
            </span>
        </div>
    );
}
