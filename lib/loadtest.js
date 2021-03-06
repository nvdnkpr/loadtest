'use strict';

/**
 * Load Test a URL, website or websocket.
 * (C) 2013 Alex Fernández.
 */


// requires
var urlLib = require('url');
var http = require('http');
var Log = require('log');
var fs = require('fs');
var prototypes = require('./prototypes.js');
var timing = require('./timing.js');
var websocket = require('./websocket.js');

// globals
var log = new Log('info');

// constants
var DEFAULT_OPTIONS = {
	noAgent: true,
	concurrency: 1,
};
var SHOW_INTERVAL_MS = 5000;


/**
 * A client for an HTTP connection.
 * Operation is an object which has these attributes:
 *	- latency: a variable to measure latency.
 *	- running: if the operation is running or not.
 * Params is an object with the same options as exports.loadTest.
 */
function HttpClient(operation, params)
{
	// self-reference
	var self = this;

	// attributes
	var requestTimer;
	var options;
	var message;
	
	// init
	init();

	/**
	 * Init options and message to send.
	 */
	function init()
	{
		if (params.agentKeepAlive)
		{
			var keepalive = require('agentkeepalive');
			var keepAliveAgent = new keepalive({
				maxSockets: params.concurrency,
				maxKeepAliveRequests: 0, // max requests per keepalive socket, default is 0, no limit
				maxKeepAliveTime: 3000  // keepalive for 30 seconds
			});
		}
		options = urlLib.parse(params.url);
		options.headers = {};
		if (params.noAgent)
		{
			options.agent = false;
		}
		if (params.agentKeepAlive)
		{
			options.agent = keepAliveAgent;
		}
		if (params.method)
		{
			options.method = params.method;
		}
		if (params.body)
		{
			if (typeof params.body == 'string')
			{
				log.debug('Received string body');
				message = params.body;
			}
			else if (typeof params.body == 'object')
			{
				log.debug('Received JSON body');
				message = JSON.stringify(params.body);
			}
			else
			{
				log.error('Unrecognized body: %s', typeof params.body);
			}
			options.headers['Content-Length'] = message.length;
			options.headers['Content-Type'] = params.contentType || 'text/plain';
		}
		if (params.cookies)
		{
			options.headers['Set-Cookie'] = params.cookies;
		}
	}

	/**
	 * Start the HTTP client.
	 */
	self.start = function()
	{
		if (!params.requestsPerSecond)
		{
			return self.makeRequest();
		}
		var interval = 1000 / params.requestsPerSecond;
		requestTimer = new timing.HighResolutionTimer(interval, self.makeRequest);
	}

	/**
	 * Stop the HTTP client.
	 */
	self.stop = function()
	{
		if (requestTimer)
		{
			requestTimer.stop();
		}
	}

	/**
	 * Make a single request to the server.
	 */
	self.makeRequest = function()
	{
		if (!operation.running)
		{
			return;
		}
		var id = operation.latency.start(id);
		var requestFinished = getRequestFinisher(id);
		var request = http.request(options, getConnect(id, requestFinished));
		if (message)
		{
			request.write(message);
		}
		request.on('error', function(error)
		{
			requestFinished('Connection error: ' + error.message);
		});
		request.end();
	}

	/**
	 * Get a function that finishes one request and goes for the next.
	 */
	function getRequestFinisher(id)
	{
		return function(error, result)
		{
			var errorCode = null;
			if (error)
			{
				log.debug('Connection %s failed: %s', id, error);
				if (result)
				{
					errorCode = result;
				}
				else
				{
					errorCode = '-1';
				}
			}
			else
			{
				log.debug('Connection %s ended', id);
			}
			operation.latency.end(id, errorCode);
			var callback;
			if (!params.requestsPerSecond)
			{
				callback = self.makeRequest;
			}
			operation.callback(error, result, callback);
		};
	}

	/**
	 * Get a function to connect the player.
	 */
	function getConnect(id, callback)
	{
		return function(connection)
		{
			log.debug('HTTP client connected to %s with id %s', params.url, id);
			connection.setEncoding('utf8');
			connection.on('data', function(chunk)
			{
				log.debug('Body: %s', chunk);
			});
			connection.on('error', function(error)
			{
				callback('Connection ' + id + ' failed: ' + error, '1');
			});
			connection.on('end', function(result)
			{
				if (connection.statusCode >= 300)
				{
					return callback('Status code ' + connection.statusCode, connection.statusCode);
				}
				callback(null, false);
			});
		};
	}
}

/**
 * Run a load test.
 * Options is an object which may have:
 *	- url: mandatory URL to access.
 *	- concurrency: how many concurrent clients to use.
 *	- maxRequests: how many requests to send
 *	- maxSeconds: how long to run the tests.
 *	- cookies: an array of objects, each with {name:name, value:value}.
 *	- method: the method to use: POST, PUT. Default: GET, what else.
 *	- body: the contents to send along a POST or PUT request.
 *	- contentType: the MIME type to use for the body, default text/plain.
 *	- requestsPerSecond: how many requests per second per client.
 *	- agent: if true, then use connection keep-alive and http agents.
 *	- agentKeepAlive: if true, then use a special agent with keep-alive.
 *	- debug: show debug messages.
 *	- quiet: do not log any messages.
 * An optional callback will be called if/when the test finishes.
 * In this case the quiet option is enabled.
 */
exports.loadTest = function(options, callback)
{
	var constructor;
	if (!options.url)
	{
		log.error('Missing URL in options');
		return;
	}
	if (options.url.startsWith('ws://'))
	{
		constructor = websocket.WebSocketClient;
	}
	else if (options.url.startsWith('http'))
	{
		constructor = HttpClient;
	}
	else
	{
		return help();
	}
	options.concurrency = options.concurrency || 1;
	if (options.debug)
	{
		log.level = Log.DEBUG;
	}
	if (callback)
	{
		options.quiet = true;
	}
	var operation = new Operation(options, constructor, callback);
	operation.start();
}

/**
 * A load test operation.
 */
var Operation = function(options, constructor, callback)
{
	// self-reference
	var self = this;

	// attributes
	self.running = true;
	self.latency = null;
	var clients = {};
	var requests = 0;
	var showTimer;

	/**
	 * Start the operation.
	 */
	self.start = function()
	{
		self.latency = new timing.Latency(options);
		startClients();
		if (options.maxSeconds)
		{
			setTimeout(stop, options.maxSeconds * 1000);
		}
		showTimer = new timing.HighResolutionTimer(SHOW_INTERVAL_MS, self.latency.showPartial);
	}

	/**
	 * Call after each operation has finished.
	 */
	self.callback = function(error, result, next)
	{
		requests += 1;
		if (options.maxRequests)
		{
			if (requests == options.maxRequests)
			{
				stop();
			}
			if (requests > options.maxRequests)
			{
				log.debug('Should have no more running clients');
			}
		}
		if (self.running && next)
		{
			next();
		}
	}

	/**
	 * Start a number of measuring clients.
	 */
	function startClients()
	{
		var url = options.url;
		for (var index = 0; index < options.concurrency; index++)
		{
			if (options.indexParam)
			{
				options.url = url.replaceAll(indexParam, index);
			}
			var client = new constructor(self, options);
			clients[index] = client;
			if (!options.requestsPerSecond)
			{
				client.start();
			}
			else
			{
				// start each client at a random moment in one second
				var offset = Math.floor(Math.random() * 1000);
				setTimeout(client.start, offset);
			}
		}
	}

	/**
	 * Stop clients.
	 */
	function stop()
	{
		if (showTimer)
		{
			showTimer.stop();
		}
		self.running = false;
		for (var index in clients)
		{
			clients[index].stop();
		}
		if (callback)
		{
			callback(null, self.latency.getResults());
		}
	}
}

/**
 * Display online help.
 */
function help()
{
	console.log('Usage: loadtest [options] URL');
	console.log('  where URL can be a regular HTTP or websocket URL:');
	console.log('  runs a load test for the given URL');
	console.log('Apache ab-compatible options are:');
	console.log('    -n requests     Number of requests to perform');
	console.log('    -c concurrency  Number of multiple requests to make');
	console.log('    -t timelimit    Seconds to max. wait for responses');
	console.log('    -C name=value   Send a cookie with the given name');
	console.log('    -T content-type The MIME type for the body');
	console.log('    -p POST-file    Send the contents of the file as POST body');
	console.log('    -u PUT-file     Send the contents of the file as PUT body');
	console.log('    -r              Do not exit on socket receive errors');
	console.log('Other options are:');
	console.log('    --rps           Requests per second for each client');
	console.log('    --noagent       Do not use http agent (default)');
	console.log('    --agent         Use http agent (Connection: keep-alive)');
	console.log('    --keepalive     Use a specialized keep-alive http agent (agentkeepalive)');
	console.log('    --index param   Replace the value of param with an index in the URL');
	console.log('    --quiet         Do not log any messages');
	console.log('    --debug         Show debug messages');
}

/**
 * Parse one argument and change options accordingly.
 * Returns true if there may be more arguments to parse.
 */
function parseArgument(args, options)
{
	if (args.length <= 1)
	{
		return false;
	}
	if (!args[0].startsWith('-'))
	{
		return false;
	}
	// consume the argument
	var argument = args.shift();
	switch(argument)
	{
		case '-n':
			options.maxRequests = args.shift();
			return true;
		case '-c':
			options.concurrency = args.shift();
			return true;
		case '-t':
			options.maxSeconds = args.shift();
			return true;
		case '-C':
			addCookie(args.shift(), options);
			return true;
		case '-T':
			options.contentType = args.shift();
			return true;
		case '-p':
			options.method = 'POST';
			options.body = fs.readFileSync(args.shift()).toString();
			return true;
		case '-u':
			options.method = 'PUT';
			options.body = fs.readFileSync(args.shift()).toString();
			return true;
		case '-r':
			options.recover = true;
			return true;
		case '--rps':
			options.requestsPerSecond = parseFloat(args.shift());
			return true;
		case '--noagent':
			return true;
		case '--agent':
			options.noAgent = false;
			return true;
		case '--keepalive':
			options.agentKeepAlive = true;
			return true;
		case '--quiet':
			options.quiet = true;
			return true;
		case '--debug':
			options.debug = true;
			return true;
	}
	console.error('Unknown option %s', argument);
	return false;
}

/**
 * Add a cookie to the options.
 */
function addCookie(cookie, options)
{
	if (!options.cookies)
	{
		options.cookies = [];
	}
	options.cookies.push(cookie);
}

/**
 * Process command line arguments and run
 */
exports.run = function(args)
{
	var options = DEFAULT_OPTIONS;
	while (parseArgument(args, options))
	{
	}
	if (args.length != 1)
	{
		if (args.length == 0)
		{
			console.error('Missing URL');
		}
		else
		{
			console.error('Unknown arguments %s', JSON.stringify(args));
		}
		return help();
	}
	options.url = args[0];
	exports.loadTest(options);
}

// start load test if invoked directly
if (__filename == process.argv[1])
{
	exports.run(process.argv.slice(2));
}

