export const defStrip = [
	{
		'id': 'ch',
		'digits': 0,
		'min': 1,
		'max': 40,
		'description': 'Channel',
		'label': 'Channel',
		'hasRel': true,
		'act': 'baseActions',
		'send': 'send_bm'
	},
	{
		'id': 'aux',
		'digits': 0,
		'min': 1,
		'max': 8,
		'description': 'Aux In',
		'label': 'Aux',
		'hasRel': true,
		'act': 'baseActions',
		'send': 'send_bm'
	},
	{
		'id': 'bus',
		'digits': 0,
		'min': 1,
		'max': 16,
		'description': 'Bus Master',
		'label': 'Bus',
		'hasRel': true,
		'act': 'baseActions',
		'send': 'send_bmm',
		'sendID': 'send/'
	},
	{
		'id': 'main',
		'digits': 0,
		'min': 1,
		'max': 4,
		'description': 'Main Master',
		'label': 'Main',
		'act': 'baseActions',
		'hasRel': true,
		'send': 'send_m',
		'sendID': 'main/'
	},
	{
		'id': 'mtx',
		'digits': 0,
		'min': 1,
		'max': 8,
		'description': 'Matrix Master',
		'label': 'Matrix',
		'hasRel': true,
		'act': 'baseActions',
		'send': 'direct',
		'sendID': 'send/MX'
	},
	{
		'id': 'dir',
		'digits': 0,
		'min': 0,
		'max': 0,
		'description': 'Direct In',
		'label': 'Direct',
		'hasRel': false,
		'sendID': 'dir/'
	},
	{
		'id': 'dca',
		'digits': 0,
		'min': 1,
		'max': 16,
		'description': 'DCA Master',
		'label': 'DCA',
		'act': 'baseActions'
	},
	{
		'id': 'mgrp',
		'digits': 0,
		'min': 1,
		'max': 8,
		'description': 'Mute Group',
		'label': 'Mute Group',
		'act': 'mgrpActions'
	}
]