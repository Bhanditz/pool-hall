import EventEmitter from 'events';
import BaseWorker from './BaseWorker';

function hrtimeToMilliseconds(hrtime) {
  return Math.floor((hrtime[0] * 1e3) + (hrtime[1] / 1e6));
}

function workerInternalMessageHandler(worker, message) {
  if (message.act === 'ready') {
    worker.state = 'up'; // eslint-disable-line no-param-reassign
    worker.emit('up');
  } else if (message.act === 'heartbeat') {
    worker.emit('heartbeat');
  }
}

const PROMISE_TIMEOUT = {};

function raceTo(promise, ms, onTimeout) {
  let timeout;

  return Promise.race([
    promise,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(PROMISE_TIMEOUT), ms);
    }),
  ]).then((res) => {
    if (res === PROMISE_TIMEOUT) onTimeout();
    if (timeout) clearTimeout(timeout);

    return res;
  }).catch((err) => {
    if (timeout) clearTimeout(timeout);

    return Promise.reject(err);
  });
}

const DEFAULT_SETTINGS = {
  gentleStopTimeout: 5000,
  killTimeout: 2000,
  heartbeatWorkerInterval: 500,
  heartbeatMonitorInterval: 1000,
  heartbeatStallTolerance: 5000,
};

export default class Supervisor extends EventEmitter {
  constructor(fork) {
    super();

    this.fork = fork;
    this.configured = false;
    this.initializing = true;
    this.workerPoolCreated = false;
    this.workers = {};
    this.settings = {};
    this.closing = false;
    this.heartbeatTimestamps = {};

    this.setPoolHealth = this.setPoolHealth.bind(this);

    this.recordHeartbeat = this.recordHeartbeat.bind(this);
    this.monitorHeartbeat = this.monitorHeartbeat.bind(this);
    this.heartbeatTimeout = null;
    this.heartbeatStartedAt = null;

    this.on('workerUp', this.setPoolHealth);
    this.on('workerDown', this.setPoolHealth);
    this.on('workerHeartbeat', this.recordHeartbeat);
  }

  configure(settings, baseSettings) {
    if (this.configured) {
      throw new Error('poolHall already configured');
    }
    this.configured = true;

    ['workerCount', 'workerEnv'].forEach((prop) => {
      if (!(prop in settings)) {
        throw new Error(`Missing required setting '${prop}'`);
      }
    });


    this.settings = {
      ...DEFAULT_SETTINGS,
      ...baseSettings,
      ...settings,
    };

    if (!('minWorkerCount' in this.settings)) {
      const { workerCount } = this.settings;

      this.settings.minWorkerCount = (workerCount >= 4) ? workerCount - 2 : workerCount;
    }
  }

  start() {
    this.closing = false;
    this.createWorkerPool();
  }

  stop() {
    this.closing = true;

    return raceTo(
      this.gentleStop(),
      this.settings.gentleStopTimeout,
      () => this.emit('info:gentleStopTimeout', this.settings.gentleStopTimeout),
    ).then(this.killSequence('SIGTERM'), this.killSequence('SIGTERM'))
      .then(this.killSequence('SIGKILL'), this.killSequence('SIGKILL'));
  }

  gentleStop() {
    const promise =
      Promise.all(Object.values(this.workers).map(worker => new Promise((resolve) => {
        worker.once('down', () => resolve());
      })));

    this.internalSend({ act: 'shutdown' });

    return promise;
  }

  killSequence(signal) {
    return () => raceTo(
      this.killProcesses(signal),
      this.settings.killTimeout,
      () => this.emit('info:killTimeout', signal, this.settings.killTimeout),
    );
  }

  killProcesses(signal) {
    const liveWorkers = Object.values(this.workers).filter(worker => !worker.isDead());

    if (liveWorkers.length > 0) {
      this.emit('info:liveWorkersAtKill', signal, liveWorkers.length);

      return Promise.all(liveWorkers.map((worker) => {
        const promise = new Promise((resolve) => {
          worker.once('down', () => resolve());
        });

        worker.process.kill(signal);
        return promise;
      }));
    }

    return Promise.resolve();
  }

  createWorkerProcess(id) {
    const workerEnv = {
      ...this.settings.env,
      ...this.settings.workerEnv(id),
      POOL_HALL_ID: `${id}`,
      POOL_HALL_HEARTBEAT_INTERVAL: `${this.settings.heartbeatWorkerInterval}`,
    };

    // TODO: handle debug/inspect args
    const execArgv = [...this.settings.execArgv];

    return this.fork(this.settings.exec, this.settings.args, {
      env: workerEnv,
      execArgv,
    });
  }

  createWorkerPool() {
    if (this.workerPoolCreated) {
      return;
    }
    this.workerPoolCreated = true;

    const workerReadyPromises = [];

    for (let id = 1; id <= this.settings.workerCount; id += 1) {
      const strId = `${id}`;
      const workerProcess = this.createWorkerProcess(strId, this.settings);
      const worker = new BaseWorker({
        id: strId,
        process: workerProcess,
        state: 'down',
      }, workerInternalMessageHandler);

      this.connectWorkerProcessEvents(worker);

      worker.on('down', info => this.emit('workerDown', strId, info));
      worker.on('up', () => this.emit('workerUp', strId));
      worker.on('terminated', () => this.emit('workerTerminated', strId));
      worker.on('heartbeat', () => this.emit('workerHeartbeat', strId));

      const readyPromise = new Promise((resolve) => {
        worker.once('up', () => resolve());
      });
      workerReadyPromises.push(readyPromise);

      this.workers[strId] = worker;
    }

    Promise.all(workerReadyPromises).then(() => {
      this.heartbeatStartedAt = process.hrtime();
      this.heartbeatTimeout = setTimeout(
        this.monitorHeartbeat,
        this.settings.heartbeatMonitorInterval,
      );
      this.heartbeatTimeout.unref();
      this.emit('workerAllUp');
    });
  }

  replaceWorkerProcess(worker) {
    if (!this.closing) {
      const workerProcess = this.createWorkerProcess(worker.id, this.settings);
      worker.setProcess(workerProcess, workerInternalMessageHandler);
      this.connectWorkerProcessEvents(worker);
    }
  }

  connectWorkerProcessEvents(worker) {
    worker.process.once('exit', (exitCode, signalCode) => {
      worker.state = 'down'; // eslint-disable-line no-param-reassign
      worker.emit('down', { exitCode, signalCode });

      if (exitCode === 0) {
        worker.emit('terminated');
      } else {
        process.nextTick(() => this.replaceWorkerProcess(worker));
      }
    });
  }

  internalSend(message) {
    Object.values(this.workers)
      .forEach(worker => worker.send({ ...message, poolHallInternal: true }));
  }

  setPoolHealth() {
    const workersUp = Object.values(this.workers).filter(({ state }) => state === 'up').length;
    this.emit('info:workersUpCount', workersUp, this.settings.workerCount, this.settings.minWorkerCount);

    if (this.initializing) {
      if (workersUp === this.settings.workerCount) {
        this.internalSend({ act: 'healthy' });
        this.initializing = false;
      } else {
        this.internalSend({ act: 'unhealthy' });
      }
    } else if (workersUp >= this.settings.minWorkerCount) {
      this.internalSend({ act: 'healthy' });
    } else {
      this.internalSend({ act: 'unhealthy' });
    }
  }

  recordHeartbeat(workerId) {
    const past = this.heartbeatTimestamps[workerId] || this.heartbeatStartedAt;
    if (past !== null) {
      this.emit(
        'info:workerHeartbeatDelta',
        workerId,
        hrtimeToMilliseconds(process.hrtime(past)),
      );
    }
    this.heartbeatTimestamps[workerId] = process.hrtime();
  }

  monitorHeartbeat() {
    Object.entries(this.workers)
      // eslint-disable-next-line no-unused-vars
      .filter(([_, worker]) => !worker.isDead()).forEach(([workerId, _]) => {
        const workerHeartbeatTimestamp =
          this.heartbeatTimestamps[workerId] || this.heartbeatStartedAt;
        const heartbeatDelta = hrtimeToMilliseconds(process.hrtime(workerHeartbeatTimestamp));
        if (heartbeatDelta >= this.settings.heartbeatStallTolerance) {
          this.emit('workerStall', workerId);
          this.emit('info:workerHeartbeatDelta', workerId, heartbeatDelta);
        }
      });

    this.heartbeatTimeout = setTimeout(
      this.monitorHeartbeat,
      this.settings.heartbeatMonitorInterval,
    );
    this.heartbeatTimeout.unref();
  }
}
