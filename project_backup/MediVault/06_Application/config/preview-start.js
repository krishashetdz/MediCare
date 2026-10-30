// Preview adapter: the actual app and its public directory stay together.
const path=require('path');
require('dotenv').config({path:path.resolve(__dirname,'../../../backend/.env')});
require('dotenv').config({path:path.resolve(__dirname,'../../../frontend/.env')});
const upstream=new URL(process.env.MEDIVAULT_UPSTREAM);
process.env.PORT=upstream.port;
process.chdir(path.resolve(__dirname,'..'));
require('../server');